/**
 * SessionFacade factory.
 *
 * Builds a fully wired, pure event-sourced session: EventStore (SQLite) +
 * projection SessionManager + EventSourcedRuntime, wrapped in a SessionFacade.
 *
 * This is the primary session creation API. Modes and extensions subscribe
 * directly to EventStore TypedEvents through the facade.
 *
 * The heavy lifting lives in ./facade/* phase modules:
 *   - model-resolution:  initial model + thinking level
 *   - store-setup:       event store, workspace lock, crash recovery, fork/resume
 *   - prompt-builder:    system prompt construction
 *   - tool-assembly:     available/active tool state + prompt refresh
 *   - extension-binding: ExtensionRunner core API wiring
 *   - llm-client:        reactor-facing LLMClient factory
 * This function only sequences the phases and owns cross-phase wiring.
 */

import { join } from "node:path";
import type { ImageContent, Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir, getMainMemoryDir } from "../config.js";
import type { AgentTool, ThinkingLevel } from "./agent/index.js";
import { AuthStorage } from "./auth-storage.js";
import {
	EventStoreExtensionSessionManager,
	ExtensionRunner,
	type LoadExtensionsResult,
	type SessionStartEvent,
	type ToolDefinition as ExtensionToolDefinition,
} from "./extensions/index.js";
import { createToolRegistry } from "./intent/tool-adapter.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.js";
import { toModelConfig } from "./runtime/ai-client.js";
import { sealConfigCommandTrust } from "./resolve-config-value.js";
import { DefaultRetryPolicy } from "./runtime/policies.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";
import { SessionFacade } from "./session-facade.js";
import { SettingsManager } from "./settings-manager.js";
import { DEFAULT_LLM_TOOLS } from "./tools/index.js";
import type { BashToolOptions } from "./tools/bash.js";
import type { SchedulerEngine } from "./scheduler/engine.js";
import { wrapToolDefinitions } from "./tools/tool-definition-wrapper.js";
import { bindExtensionCore } from "./facade/extension-binding.js";
import type { ForkSource } from "./facade/fork.js";
import { createLlmClientFactory } from "./facade/llm-client.js";
import { resolveInitialModel } from "./facade/model-resolution.js";
import { createPromptBuilder } from "./facade/prompt-builder.js";
import { setupEventStore } from "./facade/store-setup.js";
import { getEventDatabasePath } from "./event-store/workspace.js";
import { ToolAssembly } from "./facade/tool-assembly.js";

export { streamWithAdaptiveThinkingFallback } from "./facade/adaptive-thinking.js";

export interface CreateSessionFacadeOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pizza/agent */
	agentDir?: string;

	/** Auth storage for credentials. */
	authStorage?: AuthStorage;
	/** Model registry. */
	modelRegistry?: ModelRegistry;
	/** Settings manager. */
	settingsManager?: SettingsManager;
	/** Resource loader (skills/context/extensions/system prompt). */
	resourceLoader?: ResourceLoader;

	/** Model to use. Default: resolved from settings/registry. */
	model?: Model<any>;
	/** Thinking level. Default: from settings, clamped to model capabilities. */
	thinkingLevel?: ThinkingLevel;

	/**
	 * Allowlist of tool names to expose to the LLM.
	 * Default: DEFAULT_LLM_TOOLS (["cli"]) plus custom/extension tools.
	 */
	tools?: string[];
	/** Custom tools to register (in addition to built-in and extension tools). */
	customTools?: ExtensionToolDefinition[];
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;

	/** Override SQLite event database path (e.g. ":memory:" for tests). */
	storagePath?: string;
	/** Override workspace id when opening a session from another workspace. */
	workspaceId?: string;
	/** Existing projection session id to activate before prompting. */
	sessionId?: string;
	/**
	 * Caller-supplied thread id — the isolation key for multi-tenant SDK use.
	 *
	 * Map your own tenant/user identity onto it (e.g. `user-1024`): events are
	 * tagged with it and context is filtered by it, so different ids share one
	 * event log without ever seeing each other's history. Passing the same id
	 * again resumes that user's conversation, so no external mapping table is
	 * needed. Omit for single-user (local) embedding — the most recent
	 * interactive thread is selected as before.
	 *
	 * Takes precedence over `sessionId` when both are given.
	 */
	threadId?: string;
	/** Existing projection session to fork into the target workspace before prompting. */
	forkFrom?: ForkSource;
	/** Whether this is a continuation of an existing session (affects model selection). */
	isContinuing?: boolean;
	/** Context token budget. Default: model.contextWindow ?? 128000. */
	contextBudget?: number;

	/**
	 * Default safe-mode when settings.json does not set one. "auto" (default)
	 * gates writes/edits/unknown via per-category approvals; false restores
	 * unconditional auto-run. Modes without an approval UI (print) pass false
	 * so one-shot automation is not blocked.
	 */
	safeModeDefault?: boolean | "auto";
	/**
	 * Whether a UI capable of resolving approvals is attached (TUI dialog,
	 * desktop GUI via rpc approve). When false (headless: gateway sub-agents),
	 * NO waiting approval handler is installed — the reactor then fails closed,
	 * auto-rejecting gated tool calls with a guidance error instead of hanging
	 * forever on an approval nobody can answer. Default: true.
	 */
	approvalUi?: boolean;

	/** Whether this session is the persistent (main) agent. */
	isMainAgent?: boolean;
	/** Main agent working directory (defaults to cwd when isMainAgent). */
	mainDir?: string;
	/** Main agent memory directory (defaults to <mainDir>/memory). */
	memoryDir?: string;
}

export interface CreateSessionFacadeResult {
	/** The created facade. */
	facade: SessionFacade;
	/** The underlying runtime (escape hatch for advanced wiring). */
	runtime: EventSourcedRuntime;
	/** Resolved model. */
	model: Model<any> | undefined;
	/** Resolved thinking level. */
	thinkingLevel: ThinkingLevel;
	/** Extensions result (for UI context setup in interactive mode). */
	extensionsResult: LoadExtensionsResult;
	/** Warning if no model could be resolved. */
	modelFallbackMessage?: string;
	/**
	 * Inject the SchedulerEngine after creation (rpc mode builds the engine
	 * once the facade exists, since dispatching needs facade.prompt()). This
	 * is what powers the agent-facing `_cron` built-in cli command.
	 */
	setSchedulerEngine?: (engine: SchedulerEngine | undefined) => void;
	/**
	 * Build and inject an LLM client after creation. Used when the facade was
	 * created without a model (first-run setup mode) and a real model is later
	 * configured via reload_providers — the runtime's llmClient starts as null
	 * and needs to be replaced before the first prompt or the reactor crashes.
	 * Returns true if a client was built and injected (i.e. a model is now
	 * available); false if there is still no model.
	 */
	setLlmClient?: () => boolean;
}

/**
 * Create a pure event-sourced SessionFacade.
 */
export async function createSessionFacade(
	options: CreateSessionFacadeOptions = {},
): Promise<CreateSessionFacadeResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const isMainAgent = options.isMainAgent ?? false;
	const mainDir = options.mainDir ?? cwd;
	const memoryDir = options.memoryDir ?? (isMainAgent ? getMainMemoryDir(mainDir) : undefined);

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);
	// Seal the "!command" config-value trust window (TOFU): every command
	// present in models.json/auth.json at this point was registered during the
	// loads above; commands that appear later (e.g. the LLM writing a payload
	// into models.json and triggering a hot reload) are refused until restart.
	sealConfigCommandTrust();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);

	let resourceLoader = options.resourceLoader;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			isMainAgent,
			mainDir: isMainAgent ? mainDir : undefined,
			memoryDir,
		});
		await resourceLoader.reload();
	}

	// ── Resolve model + thinking level ─────────────────────────────────────
	const resolution = await resolveInitialModel({
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		isContinuing: options.isContinuing,
		settingsManager,
		modelRegistry,
	});
	let model = resolution.model;
	let thinkingLevel = resolution.thinkingLevel;
	const modelFallbackMessage = resolution.modelFallbackMessage;

	// ── EventStore + projection SessionManager ─────────────────────────────
	const { store, sessionManager, workspaceLock, workspaceId } = setupEventStore({
		cwd,
		agentDir,
		rawAgentDir: options.agentDir,
		isMainAgent,
		workspaceId: options.workspaceId,
		storagePath: options.storagePath,
		sessionId: options.sessionId,
		threadId: options.threadId,
		forkFrom: options.forkFrom,
	});
	const eventStorePath =
		options.storagePath === ":memory:"
			? undefined
			: (options.storagePath ?? getEventDatabasePath(workspaceId, agentDir));

	// ── Extensions + tools ─────────────────────────────────────────────────
	const projection = sessionManager.getActiveSession();
	const extensionSessionManager = new EventStoreExtensionSessionManager({
		store,
		projection,
		cwd,
		sessionManager,
	});
	const extensionsResult = resourceLoader.getExtensions();
	const extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		extensionSessionManager,
		modelRegistry,
	);

	const requestedToolNames = options.tools ?? [...DEFAULT_LLM_TOOLS];
	const allowedToolNames = options.tools ? new Set(options.tools) : undefined;
	const shellCommandPrefix = settingsManager.getShellCommandPrefix();
	const shellPath = settingsManager.getShellPath();
	const autoResizeImages = settingsManager.getImageAutoResize();
	const cliToolOptions: BashToolOptions = { commandPrefix: shellCommandPrefix, shellPath, read: { autoResizeImages } };
	// The `tell` built-in command (agent-to-agent messaging via the gateway) is
	// wired into the cli tool for both the main agent and workspace agents — it
	// needs the agent dir to ensure/start the gateway and discover workspaces.
	if (agentDir) {
		cliToolOptions.tell = { agentDir, mainDir };
	}
	// The `skill` built-in command is wired into the cli tool whenever skills
	// are available — it lets the LLM discover and load skills on demand via
	// `_skill list` / `_skill load` / `_skill read` instead of having the full
	// skills list injected into the system prompt.
	// Registered when the session knows about any skill, including ones the user
	// has disabled — otherwise re-enabling a skill mid-session would have no
	// command to run until the next restart.
	const knownSkillCount = resourceLoader.getSkillCatalog
		? resourceLoader.getSkillCatalog().filter((entry) => entry.enabled || entry.builtinId === undefined).length
		: resourceLoader.getSkills().skills.length;
	if (knownSkillCount > 0) {
		cliToolOptions.skill = { getSkills: () => resourceLoader.getSkills().skills };
	}
	// The `cron` built-in command (scheduled prompts) is wired into the cli
	// tool with a LAZY engine getter. The SchedulerEngine is created later
	// (in rpc mode, after this facade exists — it needs facade.prompt() to
	// dispatch turns), so we hand out a mutable slot that rpc mode fills via
	// the `setSchedulerEngine` escape hatch on the result. Until then
	// getEngine() returns undefined and `_cron` degrades gracefully.
	let schedulerEngineSlot: SchedulerEngine | undefined;
	const cronScope: "main" | "workspace" = isMainAgent ? "main" : "workspace";
	cliToolOptions.cron = {
		getEngine: () => schedulerEngineSlot,
		scope: cronScope,
		getActiveSessionId: () => sessionManager.getActiveSessionId(),
	};
	const toolOptions = {
		read: { autoResizeImages },
		cli: cliToolOptions,
	};

	let runtime: EventSourcedRuntime | undefined;
	const getRuntime = (): EventSourcedRuntime | undefined => runtime;
	// Live model getter: reads the runtime's current model config + registry so
	// that model switches (via /model, RPC set_model, or extensions) are reflected
	// in both LLM API calls and ctx.model for tools. Falls back to the resolved
	// `model` if the registry lookup fails (e.g. the model was removed).
	const getModelLive = (): Model<any> | undefined => {
		const cfg = runtime?.getModel();
		if (cfg) {
			const resolved = modelRegistry.find(cfg.provider, cfg.model_id);
			if (resolved) return resolved;
		}
		return model;
	};

	const buildPrompt = createPromptBuilder({
		cwd,
		eventStorePath,
		agentDir,
		mainDir,
		memoryDir,
		isMainAgent,
		resourceLoader,
		sessionManager,
		toolOptions,
	});
	const toolAssembly = new ToolAssembly({
		cwd,
		requestedToolNames,
		allowedToolNames,
		toolOptions,
		extensionRunner,
		customTools: options.customTools ?? [],
		buildPrompt,
	});
	toolAssembly.applyActiveTools();

	bindExtensionCore({
		store,
		projection,
		sessionManager,
		extensionSessionManager,
		extensionRunner,
		toolAssembly,
		modelRegistry,
		settingsManager,
		getRuntime,
		getModelLive,
		setFallbackModel: (nextModel) => {
			model = nextModel;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level) => {
			thinkingLevel = level;
		},
	});

	const tools: AgentTool[] = wrapToolDefinitions(
		toolAssembly.availableToolDefinitions,
		() => extensionRunner.createContext(),
	);

	// ── LLM client (AI stream function -> reactor LLMClient) ───────────────
	const buildLlmClient = createLlmClientFactory({
		modelRegistry,
		settingsManager,
		extensionRunner,
		getModelLive,
		getRuntime,
	});
	const llmClient = model ? buildLlmClient() : undefined;

	const approvalSettings = settingsManager.getApprovalSettings();
	// ── Runtime ────────────────────────────────────────────────────────────
	const currentThreadId = (): string => sessionManager.getActiveThreadId() ?? projection.getDescriptor().thread_id;
	runtime = new EventSourcedRuntime({
		cwd,
		agentDir,
		store,
		ownsStore: true,
		sessionManager,
		threadId: currentThreadId,
		toolRegistry: createToolRegistry(tools),
		llmClient: llmClient as NonNullable<typeof llmClient>,
		systemPrompt: toolAssembly.systemPrompt,
		model: toModelConfig(model ?? ({ provider: "none", id: "none" } as Model<any>), thinkingLevel),
		tools: toolAssembly.runtimeToolDefinitions,
		// Safe mode is the master toggle for tool approval. Unset defaults to
		// "auto" (per-category gates below decide; getSafeModeSettingWithDefault
		// returns undefined for auto). Explicit true gates every risky call;
		// explicit false auto-runs everything. Print mode passes
		// safeModeDefault: false — a one-shot user-invoked command must not
		// block on approvals it has no UI to answer.
		classifierConfig: {
			safe_mode: settingsManager.getSafeModeSettingWithDefault(options.safeModeDefault ?? "auto"),
			require_approval_writes: approvalSettings.writes,
			require_approval_edits: approvalSettings.edits,
			require_approval_shell_moderate: approvalSettings.shellModerate,
			require_approval_unknown: approvalSettings.unknown,
		},
		// The facade has no built-in approval dialog; the UI (TUI / web / desktop)
		// discovers pending approvals via the INTENT_TOOL_CALL event and resolves
		// them through runtime.approve()/reject(). This no-op handler keeps the
		// reactor waiting so safe mode can be toggled live. Headless callers
		// (approvalUi: false — gateway sub-agents) get NO handler: the reactor
		// then auto-rejects gated calls with a guidance error (fail closed)
		// instead of waiting forever on an approval nobody can answer.
		approvalHandler:
			options.approvalUi === false
				? undefined
				: {
						requestApproval: () => {},
						cancelApproval: () => {},
					},
		retryAssistantErrorCompletions: true,
		retryPolicy: new DefaultRetryPolicy({ capDelayMs: settingsManager.getRetrySettings().maxDelayMs }),
		contextBudget: options.contextBudget ?? model?.contextWindow ?? 128000,
		refreshSystemPrompt: () => {
			// Rebuild the system prompt with the current session-position
			// breadcrumb on session boundary events (split/fork/jump).
			if (isMainAgent) {
				resourceLoader.refreshMainAgentResources?.();
			}
			return toolAssembly.refreshSystemPrompt();
		},
		beforeAgentStart: async (payload) => {
			// Fire before_agent_start extension hooks (e.g. built-in extensions
			// injecting usage hints into the system prompt). Always rebuild from
			// the canonical base first so repeated turns do not accumulate
			// injections, then apply the extensions’ chained result on top.
			const base = toolAssembly.refreshSystemPrompt();
			const combined = await extensionRunner.emitBeforeAgentStart(
				payload.prompt,
				payload.images as ImageContent[] | undefined,
				base,
				{
					cwd,
					skills: resourceLoader.getSkills().skills,
					contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
					customPrompt: resourceLoader.getSystemPrompt(),
				},
			);
			const systemPrompt = combined?.systemPrompt;
			if (systemPrompt) {
				runtime?.setSystemPrompt(systemPrompt);
				return { systemPrompt };
			}
			return { systemPrompt: base };
		},
	});
	toolAssembly.attachRuntime(runtime);

	const extensionEventUnsubscribe = extensionRunner.bindEventStore(store);
	await extensionRunner.emit(options.sessionStartEvent ?? { type: "session_start", reason: "startup" });

	const facade = new SessionFacade({
		runtime,
		settingsManager,
		modelRegistry,
		extensionRunner,
		resourceLoader,
		disposers: workspaceLock ? [extensionEventUnsubscribe, workspaceLock.release] : [extensionEventUnsubscribe],
	});

	return {
		facade,
		runtime,
		model,
		thinkingLevel,
		extensionsResult,
		modelFallbackMessage,
		/** Let rpc mode inject the SchedulerEngine once it is created. */
		setSchedulerEngine: (engine: SchedulerEngine | undefined) => {
			schedulerEngineSlot = engine;
		},
		/** Build + inject an LLM client once a model becomes available. */
		setLlmClient: () => {
			const liveModel = getModelLive();
			if (!liveModel) return false;
			runtime?.setLlmClient(buildLlmClient());
			return true;
		},
	};
}