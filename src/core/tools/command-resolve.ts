/**
 * Resolve one cli command line against the command table — exactly once per
 * tool call. The result drives approval classification, the `tool_call`
 * hook, execution and rendering.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CliCommandDefinition } from "../extensions/types.js";
import type { ResolvedToolCall } from "../intent/types.js";
import { firstPureCommandSegment, hasShellControlSyntax, splitShellWords } from "../exec/shell-words.js";
import { isHelpRequest, parseBuiltinCommand } from "./builtin-commands.js";
import type { CliCommandSource, CommandRegistry } from "./command-registry.js";
import { checkShellPolicy, type ShellOptions } from "./shell.js";

export type ResolvedCliCommand =
	| {
			kind: "command";
			source: CliCommandSource;
			name: string;
			params: unknown;
			spec: CliCommandDefinition;
			raw: string;
	  }
	| { kind: "help"; source: CliCommandSource; name: string; text: string; raw: string }
	| { kind: "shell"; raw: string }
	| { kind: "unavailable"; name?: string; raw: string; reason: string };

export interface ResolveCliCommandContext {
	registry: CommandRegistry;
	/** Undefined → the shell fallback is disabled. */
	shell: ShellOptions | undefined;
}

function availableNames(registry: CommandRegistry): string {
	return registry.available().map((entry) => entry.spec.name).join(", ") || "(none)";
}

function operatorRejection(name: string, raw: string): string {
	const suggested = firstPureCommandSegment(raw);
	const guidance =
		name === "_edit" || name === "_write"
			? " For multi-line or special-character content, pass it through a channel that " +
				"preserves it verbatim: _edit --edits '{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"line1\\nline2\"}' " +
				"(JSON keeps quotes/spaces/newlines), a <<EOF heredoc, or wrap the whole value in quotes. " +
				"Do not split a value across bare positional tokens."
			: suggested && suggested !== raw
				? ` Issue the leading part alone: \`${suggested}\`. For pipelines or redirections, use a plain ` +
					"shell command instead — e.g. grep PATTERN FILE, cat FILE | ..., or sed ...."
				: " Issue it as a single pure command. For pipelines or redirections, use a plain " +
					"shell command instead — e.g. grep PATTERN FILE, cat FILE | ..., or sed ....";
	return (
		`${name} is an underscore command and does not support shell operators ` +
		"(|, >, <, ;, &, &&, command substitution, or newlines)." +
		guidance
	);
}

/** Help text for a command: its own `help`, or one generated from description/usage/parameters. */
export function getCliCommandHelp(spec: CliCommandDefinition): string {
	if (spec.help) return spec.help;
	const lines = [`${spec.name} - ${spec.description}`];
	if (spec.usage) lines.push("", "Usage:", `  ${spec.usage}`);
	const properties = (spec.parameters as { properties?: Record<string, TSchema> } | undefined)?.properties;
	if (properties) {
		const required = new Set((spec.parameters as { required?: string[] }).required ?? []);
		lines.push("", "Options:");
		for (const [key, schema] of Object.entries(properties)) {
			const type = (schema as { type?: string }).type ?? "value";
			const flag = type === "boolean" ? `--${key}` : `--${key} <${type}>`;
			const description = (schema as { description?: string }).description ?? "";
			lines.push(`  ${flag.padEnd(28)}${description}${required.has(key) ? " (required)" : ""}`);
		}
		lines.push(`  ${"--json '<object>'".padEnd(28)}All parameters as one JSON object`);
	}
	lines.push(`  ${"-h, --help".padEnd(28)}Show this help.`);
	return lines.join("\n");
}

function findProperty(properties: Record<string, TSchema>, flag: string): string | undefined {
	if (flag in properties) return flag;
	const snake = flag.replace(/-/g, "_");
	if (snake in properties) return snake;
	const camel = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
	return camel in properties ? camel : undefined;
}

function coerceFlagValue(key: string, schema: TSchema, value: string): unknown {
	const type = (schema as { type?: string }).type;
	if (type === "string") return value;
	if (type === "number" || type === "integer") {
		const number = Number(value);
		if (value.trim() === "" || Number.isNaN(number)) throw new Error(`--${key} expects a number, got "${value}"`);
		return number;
	}
	if (type === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
		throw new Error(`--${key} expects true or false, got "${value}"`);
	}
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`--${key} expects a JSON value, got "${value}"`);
	}
}

/**
 * Parse `--flag value` arguments against a TypeBox object schema.
 * Booleans accept a bare `--flag`; array properties may repeat; `--json
 * '<object>'` supplies any parameters verbatim. A heredoc fills the single
 * missing required string property.
 */
export function parseSchemaArguments(schema: TSchema, args: string[], heredoc?: string): Record<string, unknown> {
	const properties = ((schema as { properties?: Record<string, TSchema> }).properties ?? {}) as Record<string, TSchema>;
	const params: Record<string, unknown> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}". Pass parameters as --name value.`);
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		if (flag === "json") {
			const raw = inline ?? args[++i];
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw ?? "");
			} catch {
				throw new Error("--json expects a JSON object");
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--json expects a JSON object");
			Object.assign(params, parsed);
			continue;
		}
		const key = findProperty(properties, flag);
		if (!key) throw new Error(`Unknown option --${flag}. Known options: ${Object.keys(properties).map((k) => `--${k}`).join(", ")}`);
		const property = properties[key]!;
		const type = (property as { type?: string }).type;
		if (type === "boolean" && inline === undefined) {
			params[key] = true;
			continue;
		}
		const value = inline ?? args[++i];
		if (value === undefined) throw new Error(`--${flag} expects a value`);
		if (type === "array") {
			const items = (property as { items?: TSchema }).items;
			const item = items ? coerceFlagValue(key, items, value) : value;
			params[key] = [...((params[key] as unknown[] | undefined) ?? []), item];
		} else {
			params[key] = coerceFlagValue(key, property, value);
		}
	}
	if (heredoc !== undefined) {
		const required = (schema as { required?: string[] }).required ?? [];
		const missing = required.filter((key) => params[key] === undefined && (properties[key] as { type?: string })?.type === "string");
		if (missing.length !== 1) throw new Error("A heredoc needs exactly one missing required string parameter to fill.");
		params[missing[0]!] = heredoc;
	}
	if (!Value.Check(schema, params)) {
		const error = Value.Errors(schema, params).First();
		throw new Error(`Invalid arguments: ${error ? `${error.path || "/"} ${error.message}` : "schema mismatch"}`);
	}
	return params;
}

/** Resolve a raw cli command line. Pure: never executes anything. */
export function resolveCliCommand(rawCommand: string, context: ResolveCliCommandContext): ResolvedCliCommand {
	const raw = rawCommand.trim();
	const parsed = parseBuiltinCommand(raw);
	const name = parsed.command.toLowerCase();
	const entry = name.startsWith("_") ? context.registry.get(name) : undefined;

	if (entry) {
		const { spec, source } = entry;
		// Help is always answerable — it describes the command, not the environment.
		// Bare non-built-in commands print help so they are discoverable without the prompt docs.
		const bare = source !== "builtin" && parsed.args.length === 0 && parsed.heredoc === undefined;
		if (bare || isHelpRequest(parsed.args)) {
			return { kind: "help", source, name, text: getCliCommandHelp(spec), raw };
		}
		if (!(spec.isAvailable?.() ?? true)) {
			return { kind: "unavailable", name, raw, reason: spec.unavailableReason ?? `${name} is not available in this session.` };
		}
		if (parsed.heredoc === undefined && hasShellControlSyntax(raw)) {
			return { kind: "unavailable", name, raw, reason: operatorRejection(name, raw) };
		}
		try {
			const params = spec.parseArguments
				? spec.parseArguments(parsed.args, parsed.heredoc, { quoteDelimitersConsumed: parsed.quoteDelimitersConsumed })
				: parseSchemaArguments(spec.parameters!, parsed.args, parsed.heredoc);
			return { kind: "command", source, name, params, spec, raw };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: "unavailable", name, raw, reason: `${message}\n(run "${name} --help" for usage)` };
		}
	}

	if (name.startsWith("_")) {
		return {
			kind: "unavailable",
			name,
			raw,
			reason: `Unknown underscore command: ${name}. Available underscore commands: ${availableNames(context.registry)}.`,
		};
	}
	if (!context.shell) {
		return {
			kind: "unavailable",
			raw,
			reason:
				`Shell commands are disabled in this session, so "${splitShellWords(raw)[0] ?? raw}" cannot run. ` +
				`Available commands: ${availableNames(context.registry)}.`,
		};
	}
	const violation = checkShellPolicy(raw, context.shell.policy);
	if (violation) return { kind: "unavailable", raw, reason: violation };
	return { kind: "shell", raw };
}

/** Project a resolved command onto the runtime-level ResolvedToolCall. */
export function toResolvedToolCall(resolved: ResolvedCliCommand): ResolvedToolCall {
	switch (resolved.kind) {
		case "command":
			return {
				intent: resolved.spec.classify?.(resolved.params) ?? { category: "unknown", description: resolved.raw.slice(0, 50) },
				command: { name: resolved.name, source: resolved.source, params: resolved.params },
			};
		case "help":
			return {
				intent: { category: "shell_safe", description: `${resolved.name} --help` },
				command: { name: resolved.name, source: resolved.source },
			};
		case "unavailable":
			// Nothing runs: the call only returns an error message.
			return { intent: { category: "shell_safe", description: resolved.raw.slice(0, 50) } };
		case "shell":
			return { command: { name: splitShellWords(resolved.raw)[0] ?? "", source: "shell" } };
	}
}
