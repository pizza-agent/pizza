/**
 * The `cli` tool — the only built-in function tool the model sees.
 *
 * Every call is resolved once against the command table (built-in, SDK and
 * extension `_xxx` commands). Table commands run in-process; anything else
 * falls through to the shell when the session enables it, and is rejected
 * otherwise.
 */

import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentToolResult } from "../agent/types.js";
import type { CliCommandDefinition, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { CliCommandSource, CommandRegistry } from "./command-registry.js";
import { type ResolvedCliCommand, resolveCliCommand, toResolvedToolCall } from "./command-resolve.js";
import { toolRenderBridge as tui } from "./render-bridge.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { createLocalBashOperations, runShellCommand, type ShellDetails, type ShellOptions } from "./shell.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.js";

const cliSchema = Type.Object({
	command: Type.String({ description: "Command to execute: an underscore command or (when enabled) a shell command" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (e.g. 1000 = 1 second; optional, no default timeout)" })),
});

export type CliToolInput = Static<typeof cliSchema>;

/** Result details of a command-table command. */
export interface CliCommandDetails {
	source: CliCommandSource;
	/** Command token, always with the underscore prefix (e.g. "_write"). */
	name: string;
	/** Parsed params the command executed with. */
	args: unknown;
	/** The command's own result details (e.g. edit diff, computer-use state). */
	details?: unknown;
}

export interface CliToolDetails extends ShellDetails {
	command?: CliCommandDetails;
}

export interface CliToolOptions {
	registry: CommandRegistry;
	/** Shell fallback configuration; undefined disables the shell entirely. */
	shell?: ShellOptions;
	/**
	 * Pre-approval resolutions consumed by execute. Pass a session-owned map so
	 * resolutions survive tool rebuilds — rebuilding drops a private cache and
	 * would silently re-resolve against a command table that changed while an
	 * approval was pending.
	 */
	resolvedCache?: Map<string, ResolvedCliCommand>;
}

const RESOLVED_CACHE_LIMIT = 256;
const CLI_PREVIEW_LINES = 5;

type CliRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	commandKey?: string;
	commandCallComponent?: Component;
	commandResultComponent?: Component;
	commandRendererState?: any;
};

type ShellResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class ShellResultRenderComponent extends Container {
	state: ShellResultRenderState = { cachedWidth: undefined, cachedLines: undefined, cachedSkipped: undefined };
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCliCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? tui().theme.fg("muted", ` (timeout ${timeout}ms)`) : "";
	const commandDisplay = command === null ? invalidArgText(tui().theme) : command ? command : tui().theme.fg("toolOutput", "...");
	return tui().theme.fg("toolTitle", tui().theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildShellResultComponent(
	component: ShellResultRenderComponent,
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: CliToolDetails },
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();
	const output = getTextOutput(result as any, showImages).trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => tui().theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = tui().truncateToVisualLines(styledOutput, CLI_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							tui().theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${tui().keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
		if (truncation?.truncated) {
			warnings.push(
				truncation.truncatedBy === "lines"
					? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
					: `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
		component.addChild(new Text(`\n${tui().theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${tui().theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

function resetCommandRendererStateIfNeeded(state: CliRenderState, key: string): void {
	if (state.commandKey === key) return;
	state.commandKey = key;
	state.commandCallComponent = undefined;
	state.commandResultComponent = undefined;
	state.commandRendererState = {};
}

function makeCommandRenderContext(
	context: Parameters<NonNullable<ToolDefinition<any, any, CliRenderState>["renderCall"]>>[2],
	args: unknown,
	lastComponent: Component | undefined,
	state: CliRenderState,
) {
	state.commandRendererState ??= {};
	return { ...context, args, lastComponent, state: state.commandRendererState };
}

/** Run a command with the call's timeout folded into its AbortSignal. */
async function runWithTimeout<T>(
	run: (signal: AbortSignal | undefined) => Promise<T>,
	signal: AbortSignal | undefined,
	timeout: number | undefined,
): Promise<T> {
	if (!timeout || timeout <= 0) return run(signal);
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) controller.abort(signal.reason);
	else signal?.addEventListener("abort", onAbort, { once: true });
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			// Commands that ignore the signal may still finish their side effects.
			reject(new Error(`Command timed out after ${timeout}ms`));
		}, timeout);
	});
	try {
		return await Promise.race([run(controller.signal), timedOut]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function describeCli(available: CliCommandDefinition[], shell: ShellOptions | undefined): { description: string; snippet: string } {
	const names = available.map((spec) => spec.name);
	const list = names.join(", ") || "(none)";
	const hasVerbatimCommands = names.includes("_edit") || names.includes("_write");
	const shellPart = shell
		? " Anything else is a shell command (grep, find, ls, cat, sed, git, npm, ...) with full shell syntax."
		: " Shell commands are disabled in this session: only the underscore commands above can run.";
	const description =
		"Execute a CLI command in the current working directory. Underscore commands are prefixed with _ and handled " +
		`internally (they never reach the shell): ${list}. Run "<name> --help" for usage.${shellPart} ` +
		"IMPORTANT: underscore commands do NOT support shell operators — no pipes (|), redirects (> <), chaining (; & &&), " +
		"command substitution, or newlines; issue each as a single pure command." +
		(shell ? " To use a pipeline or redirection, run a plain shell command instead." : "") +
		(hasVerbatimCommands
			? " For _edit/_write, a value containing quotes, multiple spaces, or newlines must go through a verbatim channel — " +
				"_edit with --edits JSON (e.g. --edits '[{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"line1\\nline2\"}]'), " +
				"_write with --content or a <<EOF heredoc, or wrap the whole value in quotes. Do NOT pass such a value as bare " +
				"positional tokens — its inner quotes/spaces get silently mangled."
			: "") +
		(shell ? ` Shell output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.` : "");
	const snippet =
		`Execute CLI commands: underscore commands (${names.join("/") || "none"}) are pure single commands with NO shell operators` +
		(shell ? "; use shell commands (grep, find, ls, cat, git, npm) for pipes/redirections" : "; shell commands are disabled");
	return { description, snippet };
}

export function createCliToolDefinition(
	cwd: string,
	options: CliToolOptions,
): ToolDefinition<typeof cliSchema, CliToolDetails | undefined, CliRenderState> {
	const { registry, shell } = options;
	const operations = shell ? (shell.operations ?? createLocalBashOperations({ shellPath: shell.shellPath })) : undefined;
	const resolveContext = { registry, shell };
	/** Resolutions made before approval, consumed by execute (keyed by tool call id). */
	const resolvedCache = options.resolvedCache ?? new Map<string, ResolvedCliCommand>();
	const { description, snippet } = describeCli(
		registry.available().map((entry) => entry.spec),
		shell,
	);

	const takeResolved = (toolCallId: string, command: string): ResolvedCliCommand => {
		const cached = resolvedCache.get(toolCallId);
		resolvedCache.delete(toolCallId);
		// A tool_call hook may rewrite the command after approval: resolve the new text.
		return cached && cached.raw === command.trim() ? cached : resolveCliCommand(command, resolveContext);
	};

	return {
		name: "cli",
		label: "cli",
		description,
		promptSnippet: snippet,
		parameters: cliSchema,
		resolve(args, toolCallId) {
			const resolved = resolveCliCommand(String(args?.command ?? ""), resolveContext);
			resolvedCache.set(toolCallId, resolved);
			if (resolvedCache.size > RESOLVED_CACHE_LIMIT) {
				resolvedCache.delete(resolvedCache.keys().next().value!);
			}
			return toResolvedToolCall(resolved);
		},
		async execute(toolCallId, { command, timeout }, signal, onUpdate, ctx) {
			const resolved = takeResolved(toolCallId, command);
			switch (resolved.kind) {
				case "help":
					return { content: [{ type: "text", text: resolved.text }], details: undefined };
				case "unavailable":
					throw new Error(resolved.reason);
				case "shell":
					return runShellCommand(resolved.raw, {
						cwd,
						operations: operations!,
						commandPrefix: shell?.commandPrefix,
						spawnHook: shell?.spawnHook,
						timeout,
						signal,
						onUpdate,
						commandNames: registry.names(),
					});
				case "command": {
					// The command was approved against this exact definition; never run a
					// different one registered while the approval was pending.
					if (registry.get(resolved.name)?.spec !== resolved.spec) {
						throw new Error(
							`${resolved.name} changed in the command table after this call was approved. Reissue the command.`,
						);
					}
					const result: AgentToolResult<any> = await runWithTimeout(
						(commandSignal) => resolved.spec.execute(toolCallId, resolved.params, commandSignal, undefined, ctx),
						signal,
						timeout,
					);
					return {
						content: result.content,
						details: {
							command: { source: resolved.source, name: resolved.name, args: resolved.params, details: result.details },
						},
					};
				}
			}
		},
		renderCall(args, renderTheme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const command = str(args?.command);
			if (command) {
				try {
					const resolved = resolveCliCommand(command, resolveContext);
					if (resolved.kind === "command" && resolved.spec.renderCall) {
						resetCommandRendererStateIfNeeded(state, JSON.stringify({ name: resolved.name, args: resolved.params }));
						const renderContext = makeCommandRenderContext(context, resolved.params, state.commandCallComponent, state);
						const component = resolved.spec.renderCall(resolved.params, renderTheme, renderContext as never);
						state.commandCallComponent = component;
						return component;
					}
				} catch {
					// Fall back to the plain command line for commands whose renderer fails.
				}
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCliCall(args));
			return text;
		},
		renderResult(result, options, renderTheme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const commandDetails = result.details?.command;
			const spec = commandDetails ? registry.get(commandDetails.name)?.spec : undefined;
			if (commandDetails && spec?.renderResult) {
				resetCommandRendererStateIfNeeded(state, JSON.stringify({ name: commandDetails.name, args: commandDetails.args }));
				const renderContext = makeCommandRenderContext(context, commandDetails.args, state.commandResultComponent, state);
				const component = spec.renderResult(
					{ content: result.content as never, details: commandDetails.details },
					options,
					renderTheme,
					renderContext as never,
				);
				state.commandResultComponent = component;
				return component;
			}
			const component = (context.lastComponent as ShellResultRenderComponent | undefined) ?? new ShellResultRenderComponent();
			rebuildShellResultComponent(component, result as any, options, context.showImages, state.startedAt, state.endedAt);
			component.invalidate();
			return component;
		},
	};
}
