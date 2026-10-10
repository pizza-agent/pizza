/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createSessionFacade() options. The SDK does the heavy lifting.
 */

import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Api, type ImageContent, type Model, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "../packages/cli/args.js";
import { processFileArguments } from "../packages/cli/file-processor.js";
import { buildInitialMessage } from "../packages/cli/initial-message.js";
import { listModels } from "../packages/cli/list-models.js";
import { getAgentDir, getMainDir, getMainMemoryDir, getModelsPath, VERSION } from "./config.js";
import {
	acquireMainLock,
	initializeMainAgent,
	type MainAgentLock,
} from "./core/main-agent.js";
import {
	type SessionServices,
	type SessionDiagnostic,
	createSessionServices,
} from "./core/session-services.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { ExtensionFactory } from "./core/extensions/types.js";
import type { ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel } from "./core/model-resolver.js";
import { installCrashHandlers } from "./core/crash-handlers.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import type { CreateSessionFacadeOptions } from "./core/session-facade-factory.js";
import { createSessionFacade, type CreateSessionFacadeResult } from "./core/session-facade-factory.js";
import { getAgentDirFromSessionDir, parseSessionRef } from "./core/session-ref.js";
import { listWorkspaceSessions, listAllSessions, type SessionListInfo } from "./core/session-listing.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, resetTimings, time } from "./core/timings.js";

import { InteractiveMode, runGuiModeWithFacade, runPrintModeWithFacade, runRpcModeWithFacade } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "../packages/tui/theme/theme.js";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";
import { handleBuiltinCommand } from "./builtin-cli.js";
import { handleUpdateCommand } from "./update-cli.js";
import { checkForUpdate, formatUpdateNotice } from "./core/update-checker.js";
import { handleGatewayCommand } from "./gateway-cli.js";
import { handleChannelCommand } from "./channel-cli.js";
import { handleAuthCommand } from "./auth-cli.js";
import { isLocalPath } from "./utils/paths.js";

function supportsXhigh(model: Model<Api>): boolean {
	return getSupportedThinkingLevels(model).includes("xhigh" as any);
}

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): SessionDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly SessionDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type AppMode = "interactive" | "print" | "json" | "rpc" | "gui" | "gateway";

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "gui") {
		return "gui";
	}
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "gateway") {
		return "gateway";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc" | "gui" | "gateway"> {
	return appMode === "json" ? "json" : "text";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to an event-session reference.
 * Accepts a full event-session ref or a session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, agentDir: string): Promise<ResolvedSession> {
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "not_found", arg: `${sessionArg} (legacy JSONL paths are no longer supported)` };
	}

	// Try to match as session ID in current project first
	const localSessions = await listWorkspaceSessions(cwd, agentDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg) || s.path === sessionArg);

	if (localMatches.length >= 1) {
		const chosen = localMatches.find((s) => s.id === sessionArg) ?? localMatches[0];
		if (localMatches.length > 1 && chosen.id !== sessionArg) {
			console.error(
				chalk.yellow(
					`Warning: "${sessionArg}" matches ${localMatches.length} sessions (${localMatches.map((s) => s.id.slice(0, 12)).join(", ")}…) — using ${chosen.id}. Use a longer prefix to disambiguate.`,
				),
			);
		}
		return { type: "local", path: chosen.path };
	}

	// Try global search across all projects
	const allSessions = await listAllSessions(agentDir);
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg) || s.path === sessionArg);

	if (globalMatches.length >= 1) {
		const match = globalMatches.find((s) => s.id === sessionArg) ?? globalMatches[0];
		if (globalMatches.length > 1 && match.id !== sessionArg) {
			console.error(
				chalk.yellow(
					`Warning: "${sessionArg}" matches ${globalMatches.length} sessions across projects — using ${match.id} (${match.cwd}). Use a longer prefix to disambiguate.`,
				),
			);
		}
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function buildSessionOptions(
	parsed: Args,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateSessionFacadeOptions;
	cliThinkingFromModel: boolean;
	diagnostics: SessionDiagnostic[];
} {
	const options: CreateSessionFacadeOptions = {};
	const diagnostics: SessionDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	// Thinking level from CLI (takes precedence over any model-level thinking)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}


	// API key from CLI - set in authStorage

	// Tools
	if (parsed.noTools) {
		// --no-tools: start with no built-in tools
		// --tools can still add specific ones back, including extension tools.
		options.tools = parsed.tools && parsed.tools.length > 0 ? [...parsed.tools] : [];
	} else if (parsed.tools) {
		options.tools = [...parsed.tools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

interface ResolvedCliResourcePaths {
	extensions?: string[];
	skills?: string[];
	promptTemplates?: string[];
	themes?: string[];
}

interface CliSessionSetup {
	services: SessionServices;
	diagnostics: SessionDiagnostic[];
	sessionOptions: CreateSessionFacadeOptions;
	cliThinkingFromModel: boolean;
}

interface FacadePrintSessionTarget {
	cwd: string;
	workspaceId?: string;
	sessionId?: string;
	forkFrom?: {
		workspaceId: string;
		sessionId: string;
	};
	hasExistingSession: boolean;
}

async function createCliSessionSetup(options: {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	parsed: Args;
	resolvedPaths: ResolvedCliResourcePaths;
	extensionFactories?: ExtensionFactory[];
	isMainAgent?: boolean;
	mainDir?: string;
	memoryDir?: string;
}): Promise<CliSessionSetup> {
	const { cwd, agentDir, authStorage, parsed, resolvedPaths, extensionFactories } = options;
	const services = await createSessionServices({
		cwd,
		agentDir,
		authStorage,
		extensionFlagValues: parsed.unknownFlags,
		isMainAgent: options.isMainAgent,
		mainDir: options.mainDir,
		memoryDir: options.memoryDir,
		resourceLoaderOptions: {
			additionalExtensionPaths: resolvedPaths.extensions,
			additionalSkillPaths: resolvedPaths.skills,
			additionalPromptTemplatePaths: resolvedPaths.promptTemplates,
			additionalThemePaths: resolvedPaths.themes,
			noExtensions: parsed.noExtensions,
			noBuiltinExtensions: parsed.noBuiltinExtensions,
			noBuiltinSkills: parsed.noBuiltinSkills,
			noSkills: parsed.noSkills,
			noPromptTemplates: parsed.noPromptTemplates,
			noThemes: parsed.noThemes,
			noContextFiles: parsed.noContextFiles,
			systemPrompt: parsed.systemPrompt,
			appendSystemPrompt: parsed.appendSystemPrompt,
			extensionFactories,
		},
	});
	const { settingsManager, modelRegistry, resourceLoader } = services;
	const diagnostics: SessionDiagnostic[] = [
		...services.diagnostics,
		...collectSettingsDiagnostics(settingsManager, "runtime creation"),
		...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		})),
	];

	const {
		options: sessionOptions,
		cliThinkingFromModel,
		diagnostics: sessionOptionDiagnostics,
	} = buildSessionOptions(
		parsed,
		modelRegistry,
		settingsManager,
	);
	diagnostics.push(...sessionOptionDiagnostics);

	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			diagnostics.push({
				type: "error",
				message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
			});
		} else {
			authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
		}
	}

	return { services, diagnostics, sessionOptions, cliThinkingFromModel };
}

function applyCliThinkingClampToFacade(created: CreateSessionFacadeResult, cliThinkingOverride: boolean): void {
	if (!created.model || !cliThinkingOverride) return;
	let effectiveThinking = created.thinkingLevel;
	if (!created.model.reasoning) {
		effectiveThinking = "off";
	} else if (effectiveThinking === "xhigh" && !supportsXhigh(created.model)) {
		effectiveThinking = "high";
	}
	if (effectiveThinking !== created.thinkingLevel) {
		// Capability clamp for THIS model only — go through the runtime rather
		// than `facade.thinkingLevel`, which would persist the downgraded value
		// as the user's global default. A model that can't do "xhigh" must not
		// permanently rewrite a saved "xhigh" preference to "high".
		created.facade.runtime.setThinkingLevel(effectiveThinking);
	}
}

async function resolveFacadePrintSessionTarget(
	parsed: Args,
	cwd: string,
	agentDir: string,
): Promise<FacadePrintSessionTarget> {
	// --no-session: ephemeral in-memory mode
	if (parsed.noSession) {
		return { cwd, hasExistingSession: false };
	}

	// --rewind <id>: jump to a specific branch point
	if (typeof parsed.rewind === "string") {
		const resolved = await resolveSessionPath(parsed.rewind, cwd, agentDir);
		switch (resolved.type) {
			case "local":
			case "global": {
				const parsedRef = parseSessionRef(resolved.path);
				if (!parsedRef.workspaceId) {
					throw new Error(`Invalid session reference: ${resolved.path}`);
				}
				return {
					cwd,
					forkFrom: {
						workspaceId: parsedRef.workspaceId,
						sessionId: parsedRef.sessionId,
					},
					hasExistingSession: true,
				};
			}
			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	// Default: auto-resume the eternal conversation
	return { cwd, hasExistingSession: true };
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PIZZA_OFFLINE);
	if (offlineMode) {
		process.env.PIZZA_OFFLINE = "1";
		process.env.PIZZA_SKIP_VERSION_CHECK = "1";
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleBuiltinCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}
	if (await handleUpdateCommand(args)) {
		return;
	}

	if (await handleGatewayCommand(args)) {
		return;
	}

	if (await handleChannelCommand(args)) {
		return;
	}

	if (await handleAuthCommand(args)) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	let appMode = resolveAppMode(parsed, process.stdin.isTTY);

	// ── Gateway daemon mode ─────────────────────────────────────────────────
	// `pizza --mode gateway` starts the agent-to-agent messaging daemon. It is
	// a lightweight process — no session facade, no LLM, no theme. It only needs
	// the agent dir (for spawning sub-agents) and the socket path. Auto-started
	// on demand by ensureGateway() (packages/gateway/gateway-lifecycle.ts).
	if (appMode === "gateway") {
		const { createGatewayServer, gatewaySocketPath } = await import("../packages/gateway/index.js");
		const agentDir = getAgentDir();
		// The socket path is set by ensureGateway() via PIZZA_GATEWAY_SOCKET, or
		// falls back to the standard location.
		const socketPath = process.env.PIZZA_GATEWAY_SOCKET ?? gatewaySocketPath();
		// The gateway needs to know the main directory so it can spawn
		// sub-agents with --main for that cwd. The gateway itself does NOT
		// run as the main agent (no --main flag → no main lock); it just
		// passes --main through to the per-workspace agent it spawns.
		const mainDir = (parsed.main || parsed.mainDir) ? getMainDir(parsed.mainDir) : undefined;
		const server = createGatewayServer({ socketPath, agentDir, mainDir, version: VERSION });
		server.on("listening", (sock: string) => {
			console.error(chalk.green(`🍕 Gateway listening on ${sock}`));
		});
		// Another live gateway already owns the socket (probed on EADDRINUSE):
		// a duplicate must never steal the path. Exit cleanly — the incumbent
		// keeps serving, and ensure_gateway's readiness check finds it.
		server.on("duplicate", (sock: string) => {
			console.error(chalk.yellow(`Gateway: another gateway already owns ${sock}; exiting duplicate.`));
			process.exit(0);
		});
		server.on("error", (error: Error) => {
			console.error(chalk.red(`Gateway error: ${error.message}`));
		});
		server.on("agentSpawned", (cwd: string) => {
			console.error(chalk.dim(`Gateway: spawned agent for ${cwd}`));
		});
		server.on("agentClosed", (cwd: string) => {
			console.error(chalk.dim(`Gateway: closed agent for ${cwd}`));
		});
		// Graceful shutdown on SIGINT / SIGTERM.
		const shutdown = async () => {
			await server.stop();
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		// The gateway hosts agents for other workspaces — a stray rejection must not
		// silently take the whole pool down with it.
		installCrashHandlers({
			label: "gateway",
			onFatal: () => server.stop(),
		});
		try {
			await server.start();
		} catch (error) {
			console.error(chalk.red(`Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`));
			process.exit(1);
		}
		// Keep the process alive.
		return;
	}
	const shouldTakeOverStdout = appMode !== "interactive" && appMode !== "gui";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// ── Persistent ("main") agent setup ───────────────────────────────────
	let isMainAgent = false;
	let mainDir: string | undefined;
	let memoryDir: string | undefined;
	let mainLock: MainAgentLock | null = null;

	if (parsed.main) {
		isMainAgent = true;
		mainDir = getMainDir(parsed.mainDir);
		memoryDir = getMainMemoryDir(mainDir, parsed.memoryDir);

		const fresh = initializeMainAgent(mainDir, memoryDir);
		if (fresh) {
			console.log(chalk.green(`Main agent initialized. Edit ${join(mainDir, "SOUL.md")} to define your personality.`));
		}

		mainLock = acquireMainLock(mainDir);
		if (!mainLock) {
			console.error(chalk.red("Another main agent instance is already running. Use --main-dir to use a different directory, or stop the other instance."));
			process.exit(1);
		}
		// Lock auto-releases on process exit via the handler inside acquireMainLock.
		// Keep the reference alive for the lifetime of the process.
	}

	// When running as main agent, cwd becomes the main working directory.
	const cwd = isMainAgent && mainDir ? mainDir : process.cwd();
	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
	const sessionDir = parsed.sessionDir ?? startupSettingsManager.getSessionDir();
	const sessionStorageAgentDir = getAgentDirFromSessionDir(sessionDir);
	const resolvedPaths: ResolvedCliResourcePaths = {
		extensions: resolveCliPaths(cwd, parsed.extensions),
		skills: resolveCliPaths(cwd, parsed.skills),
		promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates),
		themes: resolveCliPaths(cwd, parsed.themes),
	};
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));

	const target = await resolveFacadePrintSessionTarget(parsed, cwd, agentDir);
	const setup = await createCliSessionSetup({
		cwd: target.cwd,
		agentDir,
		authStorage,
		parsed,
		resolvedPaths,
		extensionFactories: options?.extensionFactories,
		isMainAgent,
		mainDir,
		memoryDir,
	});
	const { services, sessionOptions, cliThinkingFromModel } = setup;
	const { settingsManager, modelRegistry, resourceLoader } = services;

	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Shared createSessionFacade() options for all four app modes (rpc /
	// interactive / gui / print). Defined as a closure so each mode reads the
	// same resolved CLI/session state. Per-mode safety posture goes in extras:
	// print has no approval UI so it keeps auto-run (a one-shot the user
	// explicitly typed); gateway-spawned rpc sub-agents are headless and must
	// fail closed instead of hanging on approvals.
	const buildFacadeOptions = (extras?: { safeModeDefault?: boolean | "auto"; approvalUi?: boolean }) => ({
		cwd: target.cwd,
		agentDir: sessionStorageAgentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		model: sessionOptions.model,
		thinkingLevel: sessionOptions.thinkingLevel,
		tools: sessionOptions.tools,
		customTools: sessionOptions.customTools,
		storagePath: parsed.noSession ? ":memory:" : undefined,
		workspaceId: target.workspaceId,
		sessionId: target.sessionId,
		isContinuing: parsed.continue ?? target.hasExistingSession,
		forkFrom: target.forkFrom
			? {
					...target.forkFrom,
					agentDir: sessionStorageAgentDir,
				}
			: undefined,
		isMainAgent,
		mainDir,
		memoryDir,
		...extras,
	});

	if (appMode === "rpc") {
		initTheme(settingsManager.getTheme(), false);
		time("initTheme");

		reportDiagnostics(setup.diagnostics);
		if (setup.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exit(1);
		}
		time("createSessionFacade.setup");

		// Gateway-spawned sub-agents (PIZZA_HEADLESS=1) have no human to answer
		// approval dialogs: install no approval handler so gated tool calls are
		// auto-rejected with guidance (fail closed) instead of hanging the turn.
		// Desktop-GUI rpc keeps the default: its approve dialog resolves over rpc.
		const headless = isTruthyEnvFlag(process.env.PIZZA_HEADLESS);
		const created = await createSessionFacade(buildFacadeOptions(headless ? { approvalUi: false } : undefined));
		applyCliThinkingClampToFacade(created, parsed.thinking !== undefined || cliThinkingFromModel);
		time("createSessionFacade");

		if (!created.model) {
			// GUI first-run mode: don't exit — keep the sidecar alive so the
			// desktop app can render an in-app setup wizard. The facade will
			// use a placeholder model (provider="none", id="none"); get_state
			// will return model=undefined; the GUI detects this via
			// RpcSessionState.model === undefined and redirects to Settings.
			// CLI modes (interactive/print) below still hard-exit because
			// they have no UI to recover in.
			console.error(chalk.yellow("No models available — entering setup mode. Configure an API key in Settings to continue."));
			console.error(chalk.dim(`\nSet an API key environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY, etc.) or create ${getModelsPath()}.`));
		}

		const startupBenchmark = isTruthyEnvFlag(process.env.PIZZA_STARTUP_BENCHMARK);
		if (startupBenchmark) {
			console.error(chalk.red("Error: PIZZA_STARTUP_BENCHMARK only supports interactive mode"));
			process.exit(1);
		}

		printTimings();
		await runRpcModeWithFacade(created.facade, { setSchedulerEngine: created.setSchedulerEngine, setLlmClient: created.setLlmClient });
		return;
	}

	if (appMode === "interactive") {
		// Interactive mode via SessionFacade
		initTheme(settingsManager.getTheme(), true);
		time("initTheme");

		reportDiagnostics(setup.diagnostics);
		if (setup.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exit(1);
		}
		time("createSessionFacade.setup");

		const created = await createSessionFacade(buildFacadeOptions());
		applyCliThinkingClampToFacade(created, parsed.thinking !== undefined || cliThinkingFromModel);
		time("createSessionFacade");

		if (!created.model) {
			console.error(chalk.red("No models available."));
			console.error(chalk.yellow("\nSet an API key environment variable:"));
			console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY, etc.");
			console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
			process.exit(1);
		}

		// Read piped stdin for initial message
		const stdinContent = await readPipedStdin();
		time("readPipedStdin");
		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");

		const startupBenchmark = isTruthyEnvFlag(process.env.PIZZA_STARTUP_BENCHMARK);
		const interactiveMode = InteractiveMode.fromFacade(created, {
			modelFallbackMessage: created.modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		// Fire-and-forget update check: hits the registry matching the install
		// channel (npm / GitHub releases), cached 24h, fully silent on failure.
		if (settingsManager.getAutoUpdateCheck()) {
			void checkForUpdate().then((result) => {
				if (result?.updateAvailable) {
					interactiveMode.showUpdateNotice(formatUpdateNotice(result));
				}
			});
		}

		printTimings();
		await interactiveMode.run();
		return;
	}

	if (appMode === "gui") {
		initTheme(settingsManager.getTheme(), false);
		time("initTheme");

		reportDiagnostics(setup.diagnostics);
		if (setup.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exit(1);
		}
		time("createSessionFacade.setup");

		const created = await createSessionFacade(buildFacadeOptions());
		applyCliThinkingClampToFacade(created, parsed.thinking !== undefined || cliThinkingFromModel);
		time("createSessionFacade");

		if (!created.model) {
			console.error(chalk.red("No models available."));
			console.error(chalk.yellow("\nSet an API key environment variable:"));
			console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY, etc.");
			console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
			process.exit(1);
		}

		const stdinContent = await readPipedStdin();
		time("readPipedStdin");
		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");

		printTimings();
		await runGuiModeWithFacade(created.facade, {
			cwd: target.cwd,
			initialMessage,
			initialImages,
		});
		return;
	}

	const stdinContent = await readPipedStdin();
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), false);
	time("initTheme");

	reportDiagnostics(setup.diagnostics);
	if (setup.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createSessionFacade.setup");

	// Print mode is a one-shot command the user explicitly typed, with no UI
	// to answer approval prompts — keep the auto-run default. An explicit
	// safeMode in settings.json still wins over this default.
	const created = await createSessionFacade(buildFacadeOptions({ safeModeDefault: false }));
	applyCliThinkingClampToFacade(created, parsed.thinking !== undefined || cliThinkingFromModel);
	time("createSessionFacade");

	if (!created.model) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY, etc.");
		console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PIZZA_STARTUP_BENCHMARK);
	if (startupBenchmark) {
		console.error(chalk.red("Error: PIZZA_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	printTimings();
	try {
		const exitCode = await runPrintModeWithFacade(created.facade, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	} finally {
		created.facade.dispose();
		stopThemeWatcher();
		restoreStdout();
	}
}
