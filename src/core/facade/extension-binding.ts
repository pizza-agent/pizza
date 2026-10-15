/**
 * Extension core binding phase for createSessionFacade.
 *
 * Wires the ExtensionRunner's core API (sendMessage / setModel / tool
 * management / ...) to the store, runtime, session manager, and tool
 * assembly. All runtime access goes through a getter because the runtime is
 * constructed after extensions are bound.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "../agent/index.js";
import { estimateContextTokens } from "../compaction/index.js";
import type {
	ContextUsage,
	EventStoreExtensionSessionManager,
	ExtensionRunner,
} from "../extensions/index.js";
import type { ImageContent } from "../event-store/types.js";
import type { SqliteEventStore } from "../event-store/sqlite-store.js";
import type { ModelRegistry } from "../models/model-registry.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";
import type { EventSourcedRuntime } from "../runtime/runtime.js";
import { isPersistableThinkingLevel, type SettingsManager } from "../config/settings-manager.js";
import type { ThinkingLevel } from "../agent/index.js";
import type { ToolAssembly } from "./tool-assembly.js";

function splitUserContent(
	content: string | Array<{ type: string; [key: string]: unknown }>,
): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") {
		return { text: content };
	}

	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		} else if (part.type === "image") {
			images.push(part as unknown as ImageContent);
		}
	}

	return {
		text: textParts.join("\n"),
		images: images.length > 0 ? images : undefined,
	};
}

export function estimateContextUsage(model: Model<any> | undefined, messages: AgentMessage[]): ContextUsage | undefined {
	if (!model) return undefined;
	const estimate = estimateContextTokens(messages);
	// The catalog window can be understated (e.g. a provider field that isn't
	// actually the context limit). When the observed/estimated usage already
	// exceeds it, the catalog value is provably wrong — report the observed
	// size as the effective window instead of a misleading >100% (or, after
	// clamping, a stuck 100%).
	const contextWindow = Math.max(model.contextWindow ?? 0, estimate.tokens);
	if (contextWindow <= 0) return undefined;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent: (estimate.tokens / contextWindow) * 100,
	};
}

export interface ExtensionBindingDeps {
	store: SqliteEventStore;
	projection: SessionProjection;
	sessionManager: ProjectionSessionManager;
	extensionSessionManager: EventStoreExtensionSessionManager;
	extensionRunner: ExtensionRunner;
	toolAssembly: ToolAssembly;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	getRuntime: () => EventSourcedRuntime | undefined;
	/** Live model getter (runtime model config resolved through the registry). */
	getModelLive: () => Model<any> | undefined;
	/** Update the factory-scope fallback model (used before a runtime exists). */
	setFallbackModel: (model: Model<any>) => void;
	getThinkingLevel: () => ThinkingLevel;
	setThinkingLevel: (level: ThinkingLevel) => void;
}

export function bindExtensionCore(deps: ExtensionBindingDeps): void {
	const {
		store,
		projection,
		sessionManager,
		extensionSessionManager,
		extensionRunner,
		toolAssembly,
		modelRegistry,
		settingsManager,
		getRuntime,
	} = deps;

	const currentSessionId = (): string => sessionManager.getActiveSessionId() ?? projection.getDescriptor().session_id;
	const currentThreadId = (): string => sessionManager.getActiveThreadId() ?? projection.getDescriptor().thread_id;
	const appendSessionEntry = (entry: { type: string; [key: string]: unknown }): void => {
		store.append({
			actor_id: "runtime",
			type: "SESSION_ENTRY_APPENDED",
			payload: {
				session_id: currentSessionId(),
				entry: {
					id: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					parentId: store.head ?? null,
					timestamp: new Date().toISOString(),
					...entry,
				},
				leaf_id: store.head ?? null,
			},
			thread_id: currentThreadId(),
		});
	};

	extensionRunner.bindCore(
		{
			sendMessage: (message, options) => {
				store.append({
					actor_id: "runtime",
					type: "CUSTOM_MESSAGE",
					payload: {
						extension_id: "sdk",
						kind: message.customType,
						data: message.details ?? message.content,
						display: message.display,
					},
					thread_id: currentThreadId(),
				});

				const runtime = getRuntime();
				if (!runtime || (!options?.triggerTurn && !options?.deliverAs)) return;
				const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				if (options?.deliverAs === "steer") {
					runtime.steer(text);
				} else if (options?.deliverAs === "followUp") {
					runtime.followUp(text);
				} else if (options?.triggerTurn) {
					void runtime.prompt(text).catch((err) => {
						extensionRunner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			},
			sendUserMessage: (content, options) => {
				const runtime = getRuntime();
				if (!runtime) return;
				const { text, images } = splitUserContent(content as Parameters<typeof splitUserContent>[0]);
				if (runtime.isRunning) {
					if (options?.deliverAs === "steer") {
						runtime.steer(text, images);
					} else {
						runtime.followUp(text, images);
					}
					return;
				}
				void runtime.prompt(text, images).catch((err) => {
					extensionRunner.emitError({
						extensionPath: "<runtime>",
						event: "send_user_message",
						error: err instanceof Error ? err.message : String(err),
					});
				});
			},
			appendEntry: (customType, data) => appendSessionEntry({ type: "custom", customType, data }),
			setSessionName: (name) => {
				sessionManager.renameSession(currentSessionId(), name);
				appendSessionEntry({ type: "session_info", name });
			},
			getSessionName: () => extensionSessionManager.getSessionName(),
			setLabel: (entryId, label) => appendSessionEntry({ type: "label", targetId: entryId, label }),
			getActiveTools: () => toolAssembly.activeToolNames,
			getAllTools: () => toolAssembly.getToolInfos(),
			setActiveTools: (toolNames) => toolAssembly.applyActiveTools(toolNames),
			refreshTools: () => toolAssembly.applyActiveTools(toolAssembly.activeToolNames),
			getCommands: () =>
				extensionRunner.getRegisteredCommands().map((command) => ({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				})),
			setModel: async (nextModel) => {
				if (!modelRegistry.hasConfiguredAuth(nextModel)) return false;
				deps.setFallbackModel(nextModel);
				getRuntime()?.setModel(nextModel.provider, nextModel.id, nextModel.contextWindow);
				// Persist as global default so the next sidecar launch picks it
				// up. Best-effort: a settings-write failure must not break the
				// in-progress turn (in-memory state is already updated above).
				try {
					settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
				} catch (e) {
					console.warn(
						`[pizza] failed to persist model preference (${nextModel.provider}/${nextModel.id}): ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return true;
			},
			getThinkingLevel: deps.getThinkingLevel,
			setThinkingLevel: (level) => {
				deps.setThinkingLevel(level);
				getRuntime()?.setThinkingLevel(level);
				// Same best-effort persistence as setModel above. Levels that
				// settings.json can't represent (e.g. pi-ai's "max") are skipped.
				if (isPersistableThinkingLevel(level)) {
					try {
						settingsManager.setDefaultThinkingLevel(level);
					} catch (e) {
						console.warn(
							`[pizza] failed to persist thinking-level preference (${level}): ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				}
			},
		},
		{
			getModel: deps.getModelLive,
			isIdle: () => !getRuntime()?.isRunning,
			getSignal: () => getRuntime()?.signal,
			abort: () => getRuntime()?.abort(),
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () =>
				estimateContextUsage(
					deps.getModelLive(),
					getRuntime()?.getProjection().buildContext().messages ?? [],
				),
			compact: (options) => {
				getRuntime()?.compact({ reason: "manual" });
				void options;
			},
			getSystemPrompt: () => getRuntime()?.getSystemPrompt() ?? toolAssembly.systemPrompt,
		},
		{
			registerProvider: (name, config) => modelRegistry.registerProvider(name, config),
			unregisterProvider: (name) => modelRegistry.unregisterProvider(name),
		},
	);
}