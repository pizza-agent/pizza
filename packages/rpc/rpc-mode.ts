/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: TypedEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentMessage } from "../../src/core/agent/types.js";
import { computeMessageStats, type SessionStats } from "../../src/core/session-stats.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../src/core/extensions/index.js";
import type { EventBase, EventType, ImageContent as EventImageContent, FileAttachment } from "../../src/core/event-store/types.js";
import { takeOverStdout, writeRawStdout } from "../../src/core/output-guard.js";
import type { SessionFacade } from "../../src/core/session-facade.js";
import { makeSessionRef, parseSessionRef } from "../../src/core/session-ref.js";
import { executeBashWithOperations } from "../../src/core/bash-executor.js";
import { createLocalBashOperations } from "../../src/core/tools/bash.js";
import {
	getBuiltinExtensionInfo,
	getBuiltinExtensionInfos,
	getBuiltinExtensionLifecycle,
} from "../../src/builtin-extensions/index.js";
import { exportFromFile } from "../../src/core/export-html/index.js";
import { buildHistoryTreeNodes } from "../../src/core/projection/history-tree.js";
import { killTrackedDetachedChildren } from "../../src/utils/shell.js";
import { startPtyServer, type PtyServer } from "../pty/pty-server.js";
import { type Theme, theme } from "../../packages/tui/theme/theme.js";
import { SchedulerEngine, type Dispatcher as SchedulerDispatcher } from "../../src/core/scheduler/index.js";
import { SCHEDULED_TASK_FIRED, SCHEDULED_TASK_COMPLETED, type ScheduledTaskPatch, type SessionTarget } from "@tomsun28/pizza-protocol";
import { installCrashHandlers } from "../../src/core/crash-handlers.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcExtensionInfo,
	RpcSkillInfo,
	RpcThemeInfo,
} from "./rpc-types.js";
import { getThemesDir } from "../../src/config.js";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

function toEventImages(images?: unknown[]): EventImageContent[] | undefined {
	if (!images) return undefined;
	return images.map((image) => {
		const img = image as ImageContent & { mime_type?: string };
		return {
			type: "image",
			data: img.data,
			mime_type: img.mime_type ?? img.mimeType,
		};
	});
}

/**
 * Normalise frontend file attachment records ({ absolutePath, mimeType, name, size })
 * into the EventStore's FileAttachment shape. The sidecar's save_upload handler
 * is responsible for sanitising the filename and writing to a safe directory
 * under <cwd>/.pizza/uploads/<ws>/<session>/; we only validate structurally here.
 */
function toEventFiles(files?: unknown[]): FileAttachment[] | undefined {
	if (!files) return undefined;
	return files.map((file) => {
		const f = file as FileAttachment;
		return {
			type: "file",
			absolutePath: f.absolutePath,
			mimeType: f.mimeType ?? "",
			name: f.name,
			size: f.size,
		};
	});
}

function getLastAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return null;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => {
			return typeof block === "object" && block !== null && "type" in block;
		})
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function fillPinnedSessionTarget(
	target: SessionTarget | undefined,
	getActiveSessionId: () => string | undefined,
): SessionTarget | undefined {
	if (!target || target.kind === "current") {
		const activeSessionId = getActiveSessionId();
		return activeSessionId ? { kind: "pinned", sessionId: activeSessionId } : { kind: "pinned" };
	}
	if (target.kind !== "pinned" || target.sessionId) return target;
	const activeSessionId = getActiveSessionId();
	return activeSessionId ? { ...target, sessionId: activeSessionId } : target;
}

function fillPinnedSessionTargetPatch(
	patch: ScheduledTaskPatch,
	getActiveSessionId: () => string | undefined,
): ScheduledTaskPatch {
	if (!patch.sessionTarget || patch.sessionTarget === null) return patch;
	const sessionTarget = fillPinnedSessionTarget(patch.sessionTarget, getActiveSessionId);
	return sessionTarget === patch.sessionTarget ? patch : { ...patch, sessionTarget };
}

function getFacadeSessionEvents(facade: SessionFacade, types?: EventType[]): EventBase[] {
	const descriptor = facade.getProjection().getDescriptor();
	return facade.runtime.store.query({
		after: descriptor.event_range.start_event_id === "ORIGIN" ? undefined : descriptor.event_range.start_event_id,
		before: descriptor.event_range.end_event_id === "HEAD" ? undefined : descriptor.event_range.end_event_id,
		types,
	});
}

function getFacadeForkMessages(facade: SessionFacade): Array<{ entryId: string; text: string }> {
	return getFacadeSessionEvents(facade, ["USER_MESSAGE"])
		.map((event) => {
			const payload = event.payload as { content?: unknown };
			return { entryId: event.event_id, text: extractMessageText(payload.content) };
		})
		.filter((message) => message.text.length > 0);
}

function getFacadeLeafEventId(facade: SessionFacade): string | undefined {
	const context = facade.getProjection().buildContext();
	return context.events.at(-1)?.event_id;
}

function getFacadeSessionStats(facade: SessionFacade): SessionStats {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	return {
		...computeMessageStats(messages),
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
	};
}

/** Derive a display name + id from an extension path. Built-ins use their id. */
function extensionIdFromPath(extPath: string): string {
	const match = /^<builtin:([^>]+)>$/.exec(extPath);
	if (match) return match[1];
	const base = extPath.replace(/\.ts$/, "").replace(/\.js$/, "");
	const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
	return slash >= 0 ? base.slice(slash + 1) : base;
}

/**
 * Hash a workspace cwd to the same `ws_<12hex>` identifier used by the
 * EventStore. Mirrors src/core/event-store/workspace.ts#deriveWorkspaceId
 * so the RPC layer can accept the raw path from the frontend and compare
 * it against `descriptor.workspace_id` (which is the hash).
 */
function canonicalWorkspaceId(cwd: string): string {
	if (/^ws_[0-9a-f]{12}$/.test(cwd)) return cwd;
	const { resolve } = require("node:path") as typeof import("node:path");
	const canonical = resolve(cwd).replace(/\\/g, "/");
	return `ws_${require("node:crypto").createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function workspaceIdMatches(provided: string | undefined, expected: string | undefined): boolean {
	if (provided === expected) return true;
	if (!provided || !expected) return false;
	return canonicalWorkspaceId(provided) === canonicalWorkspaceId(expected);
}

/** Map a loaded extension's sourceInfo/path to the RPC kind. */
function extensionKind(ext: {
	path: string;
	sourceInfo: { source: string; scope: string; origin: string };
}): RpcExtensionInfo["kind"] {
	if (/^<builtin:/.test(ext.path)) return "builtin";
	if (ext.sourceInfo.origin === "package") return "package";
	if (ext.sourceInfo.source === "cli") return "cli";
	if (ext.sourceInfo.scope === "project") return "project";
	return "user";
}

/** Where a skill comes from, in the same terms the `_skill list` output uses. */
function skillSourceLabel(skill: { sourceInfo: { source: string; scope?: string } }): string {
	if (skill.sourceInfo.scope === "user" || skill.sourceInfo.scope === "project") {
		return skill.sourceInfo.scope;
	}
	return skill.sourceInfo.source;
}

/**
 * Build the skill list for the `get_skills` RPC: every skill the session knows
 * about, including disabled ones so the UI can show and re-enable them.
 */
function buildSkillInfos(facade: SessionFacade): RpcSkillInfo[] {
	const loader = facade.resourceLoader;
	const catalog = loader?.getSkillCatalog?.();
	const entries =
		catalog ?? (loader?.getSkills().skills ?? []).map((skill) => ({ skill, enabled: true, builtinId: undefined }));
	return entries.map(({ skill, enabled, builtinId }) => ({
		command: `skill:${skill.name}`,
		name: skill.name,
		description: skill.description,
		enabled,
		builtin: builtinId !== undefined,
		path: skill.filePath,
		source: builtinId !== undefined ? "builtin" : skillSourceLabel(skill),
	}));
}

/**
 * Long-lived agents cache skills from process start. Re-scan the skill source
 * directories and, when something changed on disk (new/removed/edited skill
 * files), reload and rebuild tools + system prompt so the next turn and the
 * skills panel see the fresh set — same pattern as set_skill_enabled.
 */
async function refreshSkillsFromDisk(facade: SessionFacade): Promise<void> {
	const loader = facade.resourceLoader;
	if (!loader?.refreshSkillsIfChanged) return;
	let changed = false;
	try {
		changed = await loader.refreshSkillsIfChanged();
	} catch {
		// A failed re-scan must never break the RPC; keep serving stale skills.
		return;
	}
	if (changed) {
		facade.extensionRunner?.refreshTools();
	}
}

/**
 * Build the full extension list for the `get_extensions` RPC: every loaded
 * extension (enabled), plus any disabled built-ins (so the UI can show and
 * re-enable them).
 */
async function buildExtensionInfos(facade: SessionFacade): Promise<RpcExtensionInfo[]> {
	const infos: RpcExtensionInfo[] = [];
	const loadedIds = new Set<string>();
	const loaded = facade.resourceLoader?.getExtensions().extensions ?? [];
	const cwd = facade.runtime?.cwd ?? process.cwd();

	// Resolve install state (installed?) for every installable built-in up front,
	// concurrently. Best-effort: a failed check defaults to "not installed".
	const installState = new Map<string, { installed: boolean; version?: string }>();
	await Promise.all(
		getBuiltinExtensionInfos().map(async (info) => {
			const lc = getBuiltinExtensionLifecycle(info.id);
			if (!lc?.installable || !lc.checkInstalled) return;
			try {
				installState.set(info.id, await lc.checkInstalled(cwd));
			} catch {
				installState.set(info.id, { installed: false });
			}
		}),
	);

	const installableFor = (id: string): boolean => Boolean(getBuiltinExtensionLifecycle(id)?.installable);

	for (const ext of loaded) {
		const id = extensionIdFromPath(ext.path);
		loadedIds.add(id);
		const builtin = getBuiltinExtensionInfo(id);
		const installable = installableFor(id);
		infos.push({
			id,
			name: builtin?.name ?? id,
			description: builtin?.description,
			kind: extensionKind(ext),
			enabled: true,
			canToggle: Boolean(builtin),
			installable,
			installed: installable ? (installState.get(id)?.installed ?? false) : true,
			path: ext.path,
			toolCount: ext.tools.size,
			commandCount: ext.commands.size,
			builtinCommandCount: ext.builtinCommands?.size ?? 0,
		});
	}

	// Built-ins that are not currently loaded. A built-in shows as disabled only
	// when the user has explicitly disabled it (settings.disabledBuiltinExtensions);
	// otherwise it is considered enabled even if this facade has no resource loader
	// (e.g. minimal/embedded sessions).
	const disabledBuiltins = facade.settingsManager.getDisabledBuiltinExtensions();
	for (const info of getBuiltinExtensionInfos()) {
		if (loadedIds.has(info.id)) continue;
		const installable = installableFor(info.id);
		infos.push({
			id: info.id,
			name: info.name,
			description: info.description,
			kind: "builtin",
			enabled: !disabledBuiltins.has(info.id),
			canToggle: true,
			installable,
			installed: installable ? (installState.get(info.id)?.installed ?? false) : true,
			path: `<builtin:${info.id}>`,
			toolCount: 0,
			commandCount: 0,
			builtinCommandCount: 0,
		});
	}
	// Stable ordering: built-ins first, then the rest by id.
	infos.sort((a, b) => {
		if ((a.kind === "builtin") !== (b.kind === "builtin")) {
			return a.kind === "builtin" ? -1 : 1;
		}
		return a.id.localeCompare(b.id);
	});
	return infos;
}

/**
 * Build the theme list for the `get_themes` RPC: every theme the resource
 * loader resolved (user themes dir, project dirs, extension-contributed
 * themePaths), restricted to themes that expose web/desktop tokens.
 */
function buildThemeInfos(facade: SessionFacade): RpcThemeInfo[] {
	const builtinDir = getThemesDir();
	const themes = facade.resourceLoader?.getThemes().themes ?? [];
	const infos: RpcThemeInfo[] = [];
	for (const theme of themes) {
		if (!theme.name || !theme.web) continue;
		infos.push({
			name: theme.name,
			label: theme.web.label ?? theme.name,
			path: theme.sourcePath,
			source: theme.sourceInfo?.source,
			builtin: !theme.sourcePath || theme.sourcePath.startsWith(builtinDir),
			web: theme.web,
		});
	}
	infos.sort((a, b) => a.name.localeCompare(b.name));
	return infos;
}

/**
 * Run an install/uninstall lifecycle action for a built-in extension.
 * Returns the action result plus a freshly-checked `installed` state so the
 * UI can update without a separate refetch.
 */
/**
 * Track in-flight install/uninstall operations per extension id to prevent
 * concurrent spawns (e.g. user clicks Install twice). Without this, multiple
 * `agent-browser install` processes can race on the same Chrome download lock
 * and one of them hangs indefinitely.
 */
const lifecycleInFlight = new Map<string, Promise<{ ok: boolean; message: string; installed: boolean }>>();

async function runExtensionLifecycle(
	facade: SessionFacade,
	extensionId: string,
	action: "install" | "uninstall",
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const lc = getBuiltinExtensionLifecycle(extensionId);
	if (!lc?.installable) {
		return {
			ok: false,
			message: "This extension does not support install/uninstall.",
			installed: false,
		};
	}
	// Reject concurrent calls for the same extension id.
	const inFlight = lifecycleInFlight.get(extensionId);
	if (inFlight) {
		return {
			ok: false,
			message: `${action} already in progress for ${extensionId}.`,
			installed: false,
		};
	}
	const cwd = facade.runtime?.cwd ?? process.cwd();
	const fn = action === "install" ? lc.install : lc.uninstall;
	if (!fn) {
		return { ok: false, message: `No ${action} handler for ${extensionId}.`, installed: false };
	}
	const task = (async () => {
		try {
			const result = await fn(cwd);
			let installed = action === "install" ? result.ok : false;
			if (lc.checkInstalled) {
				try {
					installed = (await lc.checkInstalled(cwd)).installed;
				} catch {
					installed = action === "install" ? result.ok : false;
				}
			}
			return { ok: result.ok, message: result.message, installed };
		} finally {
			lifecycleInFlight.delete(extensionId);
		}
	})();
	lifecycleInFlight.set(extensionId, task);
	return task;
}

async function getExtensionPermissions(
	facade: SessionFacade,
	extensionId: string,
	recheck = false,
) {
	const lc = getBuiltinExtensionLifecycle(extensionId);
	const fn = recheck ? lc?.recheckPermissions : lc?.checkPermissions;
	if (!fn) {
		return {
			extensionId,
			supported: false,
			installed: false,
			ready: false,
			message: "This extension does not expose OS permission status.",
			permissions: [],
		};
	}
	const cwd = facade.runtime?.cwd ?? process.cwd();
	const result = await fn(cwd);
	return { extensionId, ...result };
}

async function openExtensionPermissionSettings(
	facade: SessionFacade,
	extensionId: string,
	permissionKind: "accessibility" | "screenRecording",
) {
	const lc = getBuiltinExtensionLifecycle(extensionId);
	if (!lc?.openPermissionSettings) {
		return {
			ok: false,
			message: "This extension does not support opening OS permission settings.",
		};
	}
	const cwd = facade.runtime?.cwd ?? process.cwd();
	return lc.openPermissionSettings(cwd, permissionKind);
}


/** One-line preview of a message for history_tree view / diff. */
function formatMessagePreview(message: AgentMessage): string | undefined {
	const role = (message as { role?: string }).role ?? "message";
	const content = (message as { content?: unknown }).content;
	const text = extractMessageText(content).replace(/\s+/g, " ").trim();
	if (!text) {
		// Surface tool calls even when there's no text.
		const toolCalls = Array.isArray(content)
			? content.filter((b) => (b as { type?: string }).type === "toolCall").length
			: 0;
		if (toolCalls > 0) return `${role}: [${toolCalls} tool call${toolCalls === 1 ? "" : "s"}]`;
		return undefined;
	}
	const truncated = text.length > 140 ? `${text.slice(0, 140)}…` : text;
	return `${role}: ${truncated}`;
}

function resolveSessionId(facade: SessionFacade, ref: string): string {
	const parsed = parseSessionRef(ref);
	if (parsed.workspaceId && parsed.workspaceId !== facade.runtime.store.workspace_id) {
		throw new Error(`Session belongs to a different workspace: ${parsed.workspaceId}`);
	}
	return parsed.sessionId;
}

function getFacadeSessionState(facade: SessionFacade, ptyPort?: number): RpcSessionState {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	const resolvedModel = facade.modelRegistry?.find(facade.model.provider, facade.model.model_id);
	const contextWindow = (resolvedModel as { contextWindow?: number } | undefined)?.contextWindow ?? 0;

	// Context usage estimate — uses the last assistant usage when available,
	// falling back to a rough char/4 estimate for trailing messages.
	let contextUsage: RpcSessionState["contextUsage"];
	if (contextWindow > 0) {
		let tokens: number | null = null;
		// Find last assistant usage to get an accurate context token count.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { role?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string };
			if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
				const u = msg.usage;
				tokens = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				// Add rough estimate for any messages after the last usage.
				for (let j = i + 1; j < messages.length; j++) {
					tokens += estimateMessageTokens(messages[j] as AgentMessage);
				}
				break;
			}
		}
		if (tokens === null) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateMessageTokens(message as AgentMessage);
			}
			tokens = estimated;
		}
		contextUsage = {
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
		};
	}

	// Cumulative token usage across all assistant messages.
	let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
	for (const msg of messages) {
		const m = msg as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
		if (m.role === "assistant" && m.usage) {
			const u = m.usage;
			totalInput += u.input ?? 0;
			totalOutput += u.output ?? 0;
			totalCacheRead += u.cacheRead ?? 0;
			totalCacheWrite += u.cacheWrite ?? 0;
			totalCost += u.cost?.total ?? 0;
		}
	}
	const tokenUsage = { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost };

	return {
		model: resolvedModel,
		thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
		isStreaming: facade.isRunning,
		isCompacting: false,
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
		threadId: descriptor.thread_id,
		autoCompactionEnabled: facade.settingsManager.getCompactionEnabled(),
		messageCount: messages.length,
		pendingMessageCount: 0,
		safeMode: facade.runtime.isSafeMode,
		approvalPolicy: (() => {
			const raw = facade.settingsManager.getSafeModeSetting();
			return raw === true ? "on" as const : raw === false ? "off" as const : "auto" as const;
		})(),
		ptyPort,
		contextUsage,
		tokenUsage,
	};
}

/** Rough token estimate for a message (chars / 4). Used when no usage data is available. */
function estimateMessageTokens(msg: AgentMessage): number {
	const content = "content" in msg ? (msg as { content?: unknown }).content : undefined;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((c) => (c as { type?: string }).type === "text").map((c) => (c as { text?: string }).text ?? "").join("")
			: "";
	return Math.ceil(text.length / 4);
}

/**
 * Run RPC mode against the event-sourced facade.
 * Events are emitted as raw EventStore TypedEvent JSON lines.
 */
export interface RunRpcModeOptions {
	/**
	 * Inject the SchedulerEngine into the facade's cli tool so the agent's
	 * `_cron` built-in command can manage schedules. Created in this mode
	 * after the facade exists; handed back via the facade-factory escape hatch.
	 */
	setSchedulerEngine?: (engine: SchedulerEngine | undefined) => void;
	/**
	 * Build and inject an LLM client into the runtime. Used by reload_providers
	 * when the facade was created without a model (first-run setup mode) and a
	 * real model has just been configured. Returns true if a client was built.
	 */
	setLlmClient?: () => boolean;
}

export async function runRpcModeWithFacade(
	facade: SessionFacade,
	options?: RunRpcModeOptions,
): Promise<never> {
	takeOverStdout();
	let unsubscribe: (() => void) | undefined;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let ptyServer: PtyServer | undefined;
	// Start the local PTY-over-WebSocket server for the Terminal pane. We await
	// only the socket bind (fast, never blocks on node-pty, which loads lazily
	// per connection) so `ptyPort` is ready before the first get_state. Any
	// failure is non-fatal — ptyPort stays undefined and the pane degrades.
	try {
		ptyServer = await startPtyServer({ cwd: process.cwd() });
	} catch { /* PTY server unavailable; terminal pane degrades */ }

	// ----------------------------------------------------------------------
	// Scheduler — fires the user's saved tasks by dispatching them to the
	// facade. One engine per RPC process; the engine reads/writes
	// ~/.pizza/main/scheduler/tasks.json (or per-workspace when the sidecar
	// was launched in a non-main workspace). Engine is disposed during
	// shutdown so no orphan timers fire after the sidecar exits.
	// ----------------------------------------------------------------------
	// The SessionDescriptor only carries a hashed workspace_id, so we can't
	// tell from the descriptor alone whether this sidecar is the persistent
	// main agent. The CLI surfaces "--main" via process.argv, so we detect
	// that here. The desktop Tauri bridge also passes --main when spawning
	// the sidecar for the main agent.
	const descriptor = facade.getProjection().getDescriptor();
	const isMain = process.argv.includes("--main");
	const schedulerScope: "main" | "workspace" = isMain ? "main" : "workspace";
	const schedulerWorkspaceId = isMain ? undefined : descriptor.workspace_id;
	const schedulerDispatcher: SchedulerDispatcher = {
		dispatch: async (task): Promise<{ eventId?: string; sessionId?: string; error?: string }> => {
			try {
				let dispatchedUserMessageId: string | undefined;
				let promptSessionId: string | undefined;
				// For SessionTarget: new, spawn a fresh session before the prompt.
				// For SessionTarget: pinned, temporarily switch to the saved
				// logical session. In both cases we restore the user's previous
				// active session in `finally` so scheduled tasks do not hijack
				// their visible chat.
				const target = task.sessionTarget ?? { kind: "current" };
				const sessionManager = facade.runtime.sessionManager;
				let previousActiveSessionId: string | undefined;
				let taskTargetNewSessionId: string | undefined;
				let taskTargetPinnedSessionId: string | undefined;
				if (target.kind === "new") {
					previousActiveSessionId = sessionManager?.getActiveSessionId();
					try {
						sessionManager?.createThread(target.purpose || undefined, "schedule");
						const newSessionId = sessionManager?.getActiveSessionId();
						if (!newSessionId) {
							return { error: "sessionManager unavailable; cannot create new session" };
						}
						taskTargetNewSessionId = newSessionId;
					} catch (e) {
						return { error: `createSession failed: ${e instanceof Error ? e.message : String(e)}` };
					}
				} else if (target.kind === "pinned") {
					if (!target.sessionId) {
						return { error: "pinned session target is missing sessionId" };
					}
					if (!sessionManager) {
						return { error: "sessionManager unavailable; cannot switch to pinned session" };
					}
					previousActiveSessionId = sessionManager.getActiveSessionId();
					try {
						sessionManager.switchToExistingSession(target.sessionId, "scheduled task", {
							closePrevious: "never",
							background: true,
						});
						facade.runtime.refreshSystemPromptForCurrentSession();
						taskTargetPinnedSessionId = sessionManager.getActiveSessionId();
					} catch (e) {
						return { error: `switch pinned session failed: ${e instanceof Error ? e.message : String(e)}` };
					}
				}
				// Subscribe BEFORE prompt so we capture the exact event id.
				const beforeSequence = facade.runtime.store.head_sequence;
				const unsub = facade.subscribe((event) => {
					if (event.type === "USER_MESSAGE") {
						const payload = event.payload as { content?: unknown };
						if (event.sequence > beforeSequence && extractMessageText(payload.content) === task.prompt) {
							dispatchedUserMessageId = event.event_id;
						}
					}
				});
				try {
					await facade.prompt(task.prompt);
					promptSessionId = sessionManager?.getActiveSessionId();
				} finally {
					unsub();
					// Restore the user's previous active session so background
					// schedule runs do not hijack their main chat.
					if ((target.kind === "new" || target.kind === "pinned") && previousActiveSessionId && sessionManager) {
						try {
							sessionManager.switchToExistingSession(previousActiveSessionId, "schedule complete", {
								closePrevious: target.kind === "new" ? "always" : "never",
								background: true,
							});
							facade.runtime.refreshSystemPromptForCurrentSession();
						} catch {
							/* The previous session may have been removed; ignore. */
						}
					}
				}
				// Report the REAL session the task actually ran in. After the
				// restore above, getActiveSessionId() is back to the previous
				// session — but we need to remember which session the prompt
				// landed in. The engine reads sessionId from the dispatch result.
				const sessionId = promptSessionId ?? taskTargetNewSessionId ?? taskTargetPinnedSessionId ?? sessionManager?.getActiveSessionId();
				return { eventId: dispatchedUserMessageId, sessionId };
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e) };
			}
		},
		abort: (taskId) => {
			// Best-effort abort. facade.abort() drops the in-flight turn and
			// resolves any waiting settlement promises. The scheduler engine
			// handles the post-abort bookkeeping (run record, lock release).
			try {
				facade.abort();
			} catch {
				/* ignore */
			}
		},
	};
	const scheduler = new SchedulerEngine({
		scope: schedulerScope,
		workspaceId: schedulerWorkspaceId,
		dispatcher: schedulerDispatcher,
		listener: (event) => {
			// Forward scheduler lifecycle events over the rpc_event stream so
			// the UI can render the "⏰ 已触发" notice + history in real time.
			if (event.type === "task.fired") {
				const p = event.payload as { taskId: string; at: number; sessionId?: string };
				writeRawStdout(serializeJsonLine({
					type: SCHEDULED_TASK_FIRED,
					event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					payload: { taskId: p.taskId, at: p.at, sessionId: p.sessionId, scope: schedulerScope, workspaceId: schedulerWorkspaceId },
				}));
			} else if (event.type === "task.completed") {
				writeRawStdout(serializeJsonLine({
					type: SCHEDULED_TASK_COMPLETED,
					event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					payload: event.payload,
				}));
			}
		},
	});
	scheduler.load();
	// Hand the live engine to the facade's cli tool so the agent-facing
	// `_cron` built-in command can list/create/pause/resume/delete/run the
	// same tasks the UI manages via the schedule_* RPCs.
	options?.setSchedulerEngine?.(scheduler);

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};
	const waitForCompactionEnd = (): Promise<{ summary: string; first_kept_event_id: string; tokens_before: number }> => {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error("Compaction timed out"));
			}, 30000);
			const unsub = facade.subscribe((event) => {
				if (event.type === "COMPACTION_END") {
					clearTimeout(timer);
					unsub();
					resolve(event.payload as { summary: string; first_kept_event_id: string; tokens_before: number });
				}
			});
			facade.compact({ reason: "manual" });
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		// The rpc server is a long-lived sidecar for the desktop/GUI frontend.
		// Log stray rejections instead of dying, and on a fatal error tear down
		// cleanly so the frontend sees the turn end rather than a silent exit.
		// Diagnostics go to stderr — stdout is the JSONL protocol channel.
		signalCleanupHandlers.push(
			installCrashHandlers({
				label: "rpc",
				onFatal: () => {
					killTrackedDetachedChildren();
				},
			}),
		);
	};

	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		// If a turn is in flight, abort it so the reactor emits
		// AGENT_TURN_COMPLETED(reason="aborted") before we tear down.
		// Without this, the frontend never sees the turn end and stays
		// in the "streaming" state forever after the process exits.
		if (facade.isRunning) {
			facade.abort();
			// Wait briefly for the reactor to settle and write the
			// completion event to the store before we exit.
			await Promise.race([
				facade.waitForIdle(),
				new Promise<void>((resolve) => setTimeout(resolve, 3000)),
			]).catch(() => {});
		}
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		scheduler.dispose();
		await Promise.resolve(facade.dispose());
		await ptyServer?.close().catch(() => {});
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	/**
	 * Session-structure commands (new_session / switch_session / history_tree
	 * switch-jump-fork / fork / clone / rewind) place their boundary at the
	 * store head. While an agent turn is in flight the head sits INSIDE the
	 * streaming answer: the boundary would land mid-turn and steal the rest of
	 * the answer from the session where the user asked (the new/switched-to
	 * session range swallows the response tail - attribution bug). Wait for the
	 * prompt cycle - including queued follow-ups, retries and compaction - to
	 * settle first so the boundary lands after the turn final event. Resolves
	 * immediately when the runtime is idle.
	 */
	const waitForSessionStructureIdle = (): Promise<void> => facade.waitForIdle();

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			case "prompt":
				// Reject up-front when a turn is already running. The runtime throws
				// in that case, but the throw lands in the detached promise below —
				// long after we acked `success`, so the caller would believe the
				// prompt was accepted and silently lose the message. Fail the
				// command instead so the sender can queue it (steer/follow_up).
				if (facade.isRunning) {
					return error(id, "prompt", "agent is already processing a prompt; use steer or follow_up to queue");
				}
				void facade.prompt(command.message, toEventImages(command.images), toEventFiles(command.files)).catch((e: unknown) => {
					output(error(id, "prompt", e instanceof Error ? e.message : String(e)));
				});
				return success(id, "prompt");

			case "steer":
				facade.steer(command.message, toEventImages(command.images), toEventFiles(command.files));
				return success(id, "steer");

			case "follow_up":
				facade.followUp(command.message, toEventImages(command.images), toEventFiles(command.files));
				return success(id, "follow_up");

			case "get_queued_messages":
				return success(id, "get_queued_messages", { entries: facade.getQueuedEntries() });

			case "cancel_queued_message":
				return success(id, "cancel_queued_message", { removed: facade.cancelQueuedMessage(command.sourceEventId) });

			case "steer_queued_message":
				return success(id, "steer_queued_message", { promoted: facade.steerQueuedMessage(command.sourceEventId) });

			case "abort":
				facade.abort();
				return success(id, "abort");

			case "get_state":
				return success(id, "get_state", getFacadeSessionState(facade, ptyServer?.port));

			case "set_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				facade.setModel(model);
				return success(id, "set_model", model);
			}

			case "get_available_models": {
				// Return ALL models, annotated with hasAuth so the UI can show
				// unconfigured models as disabled rather than hiding them.
				const registry = facade.modelRegistry;
				const all = registry?.getAll() ?? [];
				const models = all.map((m) => ({
					id: m.id,
					name: m.name,
					api: m.api,
					provider: m.provider,
					reasoning: (m as { reasoning?: boolean }).reasoning,
					contextWindow: (m as { contextWindow?: number }).contextWindow,
					hasAuth: registry ? registry.hasConfiguredAuth(m) : true,
				}));
				return success(id, "get_available_models", { models });
			}

			case "cycle_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				if (models.length === 0) {
					return success(id, "cycle_model", null);
				}
				const current = facade.model;
				const currentIndex = models.findIndex(
					(model) => model.provider === current.provider && model.id === current.model_id,
				);
				if (models.length === 1 && currentIndex === 0) {
					return success(id, "cycle_model", null);
				}
				const model = models[(currentIndex + 1) % models.length] ?? models[0]!;
				facade.setModel(model);
				return success(id, "cycle_model", {
					model,
					thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
					isScoped: false,
				});
			}

			case "set_thinking_level":
				facade.thinkingLevel = command.level;
				return success(id, "set_thinking_level");

			case "cycle_thinking_level": {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
				const current = facade.thinkingLevel ?? "off";
				const index = levels.findIndex((level) => level === current);
				const level = levels[(index + 1) % levels.length] ?? "off";
				facade.thinkingLevel = level;
				return success(id, "cycle_thinking_level", { level });
			}

			case "compact": {
				const result = await waitForCompactionEnd();
				return success(id, "compact", {
					summary: result.summary,
					firstKeptEntryId: result.first_kept_event_id,
					tokensBefore: result.tokens_before,
				});
			}

			case "get_messages":
				return success(id, "get_messages", { messages: facade.getProjection().buildContext().messages });

			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", {
					text: getLastAssistantText(facade.getProjection().buildContext().messages),
				});

			case "rewind": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "rewind", "Projection session manager is not available");
				}
				if (command.targetEventId) {
					await waitForSessionStructureIdle();
					const event = facade.runtime.store.get(command.targetEventId);
					if (!event) {
						return error(id, "rewind", `Event not found: ${command.targetEventId}`);
					}
					sessionManager.forkAt(command.targetEventId);
				}
				// No target: no-op, eternal conversation auto-continues
				const desc = facade.getProjection().getDescriptor();
				return success(id, "rewind", { cancelled: false, sessionId: desc.session_id });
			}

			case "switch_session": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "switch_session", "Projection session manager is not available");
				}
				await waitForSessionStructureIdle();
				const desc = sessionManager.switchToExistingSession(resolveSessionId(facade, command.sessionPath), command.reason);
				facade.runtime.refreshSystemPromptForCurrentSession();
				return success(id, "switch_session", { cancelled: false, sessionId: desc.session_id });
			}

			case "fork": {
				await waitForSessionStructureIdle();
				const event = facade.runtime.store.get(command.entryId);
				if (!event) {
					return error(id, "fork", `Event not found: ${command.entryId}`);
				}
				facade.runtime.fork(command.entryId);
				return success(id, "fork", {
					text: event.type === "USER_MESSAGE" ? extractMessageText((event.payload as { content?: unknown }).content) : "",
					cancelled: false,
				});
			}

			case "clone": {
				await waitForSessionStructureIdle();
				const leafId = getFacadeLeafEventId(facade);
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				facade.runtime.fork(leafId);
				return success(id, "clone", { cancelled: false });
			}

			case "get_fork_messages":
				return success(id, "get_fork_messages", { messages: getFacadeForkMessages(facade) });

			case "get_session_stats":
				return success(id, "get_session_stats", getFacadeSessionStats(facade));

			case "set_auto_compaction":
				facade.settingsManager.setCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");

			case "get_commands": {
				const commands: RpcSlashCommand[] =
					facade.extensionRunner?.getRegisteredCommands().map((command) => ({
						name: command.invocationName,
						description: command.description,
						source: "extension" as const,
						sourceInfo: command.sourceInfo,
					})) ?? [];
				return success(id, "get_commands", { commands });
			}

			case "history_tree": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "history_tree", "Projection session manager is not available");
				}
				const store = facade.runtime.store;
				switch (command.action) {
					case "list": {
						let nodes = buildHistoryTreeNodes(
							sessionManager.listSessions(),
							sessionManager.getActiveSessionId(),
							store,
						);
						if (command.query) {
							const q = command.query.toLowerCase();
							nodes = nodes.filter(
								(n) =>
									n.name?.toLowerCase().includes(q) ||
									n.title?.toLowerCase().includes(q) ||
									n.snippet?.toLowerCase().includes(q) ||
									n.session_id.toLowerCase().includes(q),
							);
						}
						return success(id, "history_tree", { action: "list", nodes });
					}
					case "view": {
						const projection = sessionManager.getSessionProjection(command.sessionId);
						if (!projection) {
							return success(id, "history_tree", { action: "view", view: null });
						}
						const descriptor = projection.getDescriptor();
						const previews = projection
							.buildContext()
							.messages.map((m) => formatMessagePreview(m))
							.filter((line): line is string => line !== undefined);
						const maxMessages = command.maxMessages ?? 40;
						return success(id, "history_tree", {
							action: "view",
							view: {
								session_id: descriptor.session_id,
								name: descriptor.name,
								messages: previews.slice(-maxMessages),
								message_count: previews.length,
							},
						});
					}
					case "switch": {
						await waitForSessionStructureIdle();
						const target = sessionManager.resolveSwitchTargetSession(command.sessionId);
						const desc = sessionManager.switchToExistingSession(target.session_id, command.reason);
						facade.runtime.refreshSystemPromptForCurrentSession();
						return success(id, "history_tree", {
							action: "switch",
							session_id: desc.session_id,
						});
					}
					case "jump": {
						await waitForSessionStructureIdle();
						const result = sessionManager.jumpToSession(command.sessionId, command.reason);
						facade.runtime.refreshSystemPromptForCurrentSession();
						return success(id, "history_tree", {
							action: "jump",
							session_id: result.descriptor.session_id,
							reopened: result.reopened,
						});
					}
					case "fork": {
						await waitForSessionStructureIdle();
						const desc = sessionManager.forkFromSession(command.sessionId, { preserveHistory: false });
						facade.runtime.refreshSystemPromptForCurrentSession();
						return success(id, "history_tree", { action: "fork", session_id: desc.session_id });
					}
					case "rename": {
						sessionManager.renameSession(command.sessionId, command.name);
						return success(id, "history_tree", { action: "rename", ok: true });
					}
					default: {
						const unknown = command as { action?: string };
						return error(id, "history_tree", `Unknown history_tree action: ${unknown.action}`);
					}
				}
			}

			case "get_events": {
				const store = facade.runtime.store;
				const eventTypes = command.eventTypes as EventType[] | undefined;
				const events = command.sessionScoped
					? getFacadeSessionEvents(facade, eventTypes)
					: store.query({ types: eventTypes });
				const limit = command.limit ?? 1000;
				const sliced = events.length > limit ? events.slice(-limit) : events;
				return success(id, "get_events", {
					events: sliced.map((e) => ({
						event_id: e.event_id,
						type: e.type,
						timestamp: e.timestamp,
						actor_id: e.actor_id,
						caused_by: e.caused_by,
						thread_id: e.thread_id,
						payload: e.payload,
					})),
				});
			}

			case "set_auto_retry":
				return success(id, "set_auto_retry");

			case "abort_retry":
				facade.abort();
				return success(id, "abort_retry");

			case "bash": {
				const operations = createLocalBashOperations();
				const result = await executeBashWithOperations(command.command, process.cwd(), operations);
				return success(id, "bash", result);
			}

			case "abort_bash":
				return success(id, "abort_bash");

			case "export_html": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionRef = makeSessionRef(descriptor.workspace_id, descriptor.session_id);
				const path = await exportFromFile(sessionRef, command.outputPath);
				return success(id, "export_html", { path });
			}

			case "set_steering_mode":
				return success(id, "set_steering_mode");

			case "set_follow_up_mode":
				return success(id, "set_follow_up_mode");
			case "approve":
				facade.runtime.approve(command.intentEventId);
				return success(id, "approve");

			case "reject":
				facade.runtime.reject(command.intentEventId);
				return success(id, "reject");

			case "set_safe_mode": {
				const enabled = !!command.enabled;
				facade.runtime.setSafeMode(enabled);
				facade.settingsManager.setSafeMode(enabled);
				return success(id, "set_safe_mode", { safeMode: facade.runtime.isSafeMode });
			}
			case "set_approval_policy": {
				const policy = (command as unknown as { policy: "auto" | "on" | "off" }).policy;
				const safeMode = policy === "on" ? true : policy === "off" ? false : undefined;
				facade.runtime.setSafeMode(safeMode);
				facade.settingsManager.setSafeMode(safeMode === undefined ? "auto" : safeMode);
				// "auto" is the two-state UI approval mode: reset gates to the
				// standard set (unknown + dangerous gated, all else auto-runs) so
				// behavior matches the label regardless of stale gate overrides.
				if (policy === "auto") {
					const gates = { writes: false, edits: false, shellModerate: false, unknown: true };
					facade.settingsManager.setApprovalGates(gates);
					facade.runtime.setApprovalGates(gates);
				}
				return success(id, "set_approval_policy", { approvalPolicy: policy });
			}
			case "get_approval_policy": {
				const raw = facade.settingsManager.getSafeModeSetting();
				const policy = raw === true ? "on" as const : raw === false ? "off" as const : "auto" as const;
				return success(id, "get_approval_policy", { approvalPolicy: policy });
			}
			case "get_approval_gates": {
				return success(id, "get_approval_gates", { gates: facade.settingsManager.getApprovalSettings() });
			}
			case "set_approval_gates": {
				const gates = (command as unknown as { gates: { writes?: boolean; edits?: boolean; shellModerate?: boolean; unknown?: boolean } }).gates;
				facade.settingsManager.setApprovalGates(gates);
				facade.runtime.setApprovalGates(gates);
				return success(id, "set_approval_gates", { gates: facade.settingsManager.getApprovalSettings() });
			}
			case "get_scheduler_policy": {
				return success(id, "get_scheduler_policy", { policy: facade.settingsManager.getSchedulerPolicy() });
			}
			case "set_scheduler_policy": {
				const policy = (command as unknown as { policy: import("@tomsun28/pizza-protocol").SchedulerPolicy }).policy;
				facade.settingsManager.setSchedulerPolicy(policy);
				return success(id, "set_scheduler_policy", { policy: facade.settingsManager.getSchedulerPolicy() });
			}
		case "new_session": {
			// Long-lived agents cache skills from process start; pick up skills
			// added/removed on disk so each new conversation sees the current set.
			await refreshSkillsFromDisk(facade);
			await waitForSessionStructureIdle();
			const desc = facade.runtime.createSession();
			const sessionId = desc?.session_id ?? facade.runtime.sessionManager?.getActiveSessionId() ?? "";
			return success(id, "new_session", { sessionId });
		}

		case "get_skills": {
			// Same as new_session: the GUI skills panel reads from the loader, so
			// refresh from disk first to reflect newly installed skills.
			await refreshSkillsFromDisk(facade);
			const enableSkills = facade.settingsManager.getEnableSkillCommands();
			// Disabled skills are reported too (with enabled: false) so a UI can list
			// and re-enable them; callers that only want active skills filter on `enabled`.
			const skills = enableSkills ? buildSkillInfos(facade) : [];
			return success(id, "get_skills", { skills });
		}

		case "set_skill_enabled": {
			const loader = facade.resourceLoader;
			if (!loader?.setSkillEnabled) {
				return error(id, "set_skill_enabled", "This session cannot toggle skills.");
			}
			if (!loader.setSkillEnabled(command.skillName, command.enabled)) {
				return error(id, "set_skill_enabled", `Unknown skill: ${command.skillName}`);
			}
			// Rebuild tools + system prompt so the change applies to the next turn.
			// Sessions without an extension runner have no tool rebuild hook and
			// need a reload to pick the change up.
			facade.extensionRunner?.refreshTools();
			return success(id, "set_skill_enabled", {
				name: command.skillName,
				enabled: command.enabled,
				requiresReload: !facade.extensionRunner,
			});
		}

		case "delete_skill": {
			const loader = facade.resourceLoader;
			if (!loader?.deleteSkill) {
				return error(id, "delete_skill", "This session cannot delete skills.");
			}
			if (!loader.deleteSkill(command.skillName)) {
				return error(
					id,
					"delete_skill",
					`Cannot delete skill: ${command.skillName} (unknown, built-in, or package-provided)`,
				);
			}
			// Same as set_skill_enabled: rebuild tools so the next turn no longer
				// offers the deleted skill.
			facade.extensionRunner?.refreshTools();
			return success(id, "delete_skill", { name: command.skillName });
		}

		case "get_extensions": {
			const extensions = await buildExtensionInfos(facade);
			return success(id, "get_extensions", { extensions });
		}

		case "get_themes": {
			const themes = buildThemeInfos(facade);
			return success(id, "get_themes", { themes });
		}

		case "set_extension_enabled": {
			const info = getBuiltinExtensionInfo(command.extensionId);
			if (!info) {
				return error(
					id,
					"set_extension_enabled",
					"Only built-in extensions can be toggled. Manage other extensions via `pizza plugin`.",
				);
			}
			facade.settingsManager.setBuiltinExtensionDisabled(command.extensionId, !command.enabled);
			// Disabling/enabling a built-in changes which extensions are loaded; that
			// only takes full effect after the session reloads its resources.
			return success(id, "set_extension_enabled", {
				id: command.extensionId,
				enabled: command.enabled,
				requiresReload: true,
			});
		}

		case "install_extension": {
			const result = await runExtensionLifecycle(facade, command.extensionId, "install");
			return success(id, "install_extension", {
				extensionId: command.extensionId,
				ok: result.ok,
				message: result.message,
				installed: result.installed,
			});
		}

		case "uninstall_extension": {
			const result = await runExtensionLifecycle(facade, command.extensionId, "uninstall");
			return success(id, "uninstall_extension", {
				extensionId: command.extensionId,
				ok: result.ok,
				message: result.message,
				installed: result.installed,
			});
		}

		case "get_extension_permissions": {
			return success(
				id,
				"get_extension_permissions",
				await getExtensionPermissions(facade, command.extensionId),
			);
		}

		case "recheck_extension_permissions": {
			return success(
				id,
				"recheck_extension_permissions",
				await getExtensionPermissions(facade, command.extensionId, true),
			);
		}

		case "open_extension_permission_settings": {
			const result = await openExtensionPermissionSettings(
				facade,
				command.extensionId,
				command.permissionKind,
			);
			return success(id, "open_extension_permission_settings", {
				extensionId: command.extensionId,
				ok: result.ok,
				message: result.message,
			});
		}

		case "reload_providers": {
			// Credentials may be written to auth.json out-of-band (e.g. by the
			// desktop Tauri bridge). Reload the in-memory cache so model auth
			// resolution picks up the latest keys instead of a stale cache or an
			// env-var fallback. Also refresh the model registry so hasAuth flags
			// and any provider baseUrl overrides are recomputed.
			const registry = facade.modelRegistry;
			if (registry?.authStorage) {
				registry.authStorage.reload();
				registry.refresh();
			}
			// If the facade is still using the placeholder model (provider="none",
			// set at startup when no API key was configured), try to resolve a real
			// model now that credentials have been reloaded. This is critical for
			// gateway mode where restart_sidecar can't respawn the agent process —
			// without this, get_state keeps returning model=undefined and the GUI
			// bounces the user back to the setup page forever.
			const currentModel = facade.model;
			if (currentModel.provider === "none" && registry) {
				const available = registry.getAvailable();
				if (available.length > 0) {
					facade.setModel(available[0]);
					// The runtime's llmClient was left as null at startup (no model
					// → no client). Build and inject one now so the reactor can
					// actually call the provider on the first prompt — without this
					// the user configures a key, gets past the setup page, and then
					// hits "Cannot read properties of undefined (reading 'complete')"
					// on their first message.
					options?.setLlmClient?.();
				}
			}
			return success(id, "reload_providers", {
				providers: registry?.authStorage?.list() ?? [],
			});
		}

			case "schedule_list": {
				return success(id, "schedule_list", { tasks: scheduler.list() });
			}

			case "schedule_create": {
				const t = command.task;
				// The scope on the wire wins, but we validate it matches the engine.
				if (t.scope !== schedulerScope) {
					return error(id, "schedule_create", `Scope mismatch: sidecar is ${schedulerScope}, task is ${t.scope}`);
				}
				if (t.scope === "workspace") {
					if (!workspaceIdMatches(t.workspaceId, schedulerWorkspaceId)) {
						return error(id, "schedule_create", `Workspace mismatch: sidecar is ${schedulerWorkspaceId}, task is ${t.workspaceId}`);
					}
				}
				const policy = facade.settingsManager.getSchedulerPolicy();
				const r = scheduler.create({
					name: t.name,
					prompt: t.prompt,
					schedule: t.schedule,
					enabled: t.enabled,
					createdBy: t.createdBy ?? "user",
					sourceText: t.sourceText,
					startAt: t.startAt,
					endAt: t.endAt,
					sessionTarget: fillPinnedSessionTarget(
						t.sessionTarget ?? policy.defaultSessionTarget,
						() => facade.runtime.sessionManager?.getActiveSessionId(),
					),
					concurrencyPolicy: t.concurrencyPolicy ?? policy.concurrency,
					timeoutMinutes: t.timeoutMinutes ?? policy.timeoutMinutes,
				});
				if (!r.ok) return error(id, "schedule_create", r.error);
				return success(id, "schedule_create", { task: r.task });
			}

			case "schedule_update": {
				if (command.scope !== schedulerScope) {
					return error(id, "schedule_update", `Scope mismatch`);
				}
				if (command.scope === "workspace") {
					if (!workspaceIdMatches(command.workspaceId, schedulerWorkspaceId)) {
						return error(id, "schedule_update", `Workspace mismatch`);
					}
				}
				const r = scheduler.update(command.taskId, fillPinnedSessionTargetPatch(
					command.patch,
					() => facade.runtime.sessionManager?.getActiveSessionId(),
				));
				if (!r.ok) return error(id, "schedule_update", r.error);
				return success(id, "schedule_update", { task: r.task });
			}

			case "schedule_delete": {
				if (command.scope !== schedulerScope) {
					return error(id, "schedule_delete", `Scope mismatch`);
				}
				if (command.scope === "workspace") {
					if (!workspaceIdMatches(command.workspaceId, schedulerWorkspaceId)) {
						return error(id, "schedule_delete", `Workspace mismatch`);
					}
				}
				const r = scheduler.delete(command.taskId);
				if (!r.ok) return error(id, "schedule_delete", r.error);
				return success(id, "schedule_delete", { ok: true, taskId: command.taskId });
			}

			case "schedule_run_now": {
				if (command.scope !== schedulerScope) {
					return error(id, "schedule_run_now", `Scope mismatch`);
				}
				if (command.scope === "workspace") {
					if (!workspaceIdMatches(command.workspaceId, schedulerWorkspaceId)) {
						return error(id, "schedule_run_now", `Workspace mismatch`);
					}
				}
				const r = await scheduler.runNow(command.taskId);
				if (!r.ok) return error(id, "schedule_run_now", r.error);
				return success(id, "schedule_run_now", { fired: true, taskId: r.taskId, at: r.at });
			}

			case "schedule_reload": {
				const reloaded = scheduler.reload();
				return success(id, "schedule_reload", { reloaded });
			}

			case "schedule_history": {
				if (command.scope !== schedulerScope) {
					return error(id, "schedule_history", `Scope mismatch`);
				}
				if (command.scope === "workspace") {
					if (!workspaceIdMatches(command.workspaceId, schedulerWorkspaceId)) {
						return error(id, "schedule_history", `Workspace mismatch`);
					}
				}
				const runs = scheduler.history(command.taskId, command.limit ?? 50);
				return success(id, "schedule_history", { runs });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	unsubscribe = facade.subscribe((event) => output(event));
	registerSignalHandlers();

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	return new Promise(() => {});
}
