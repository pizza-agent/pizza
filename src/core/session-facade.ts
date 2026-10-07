/**
 * SessionFacade
 *
 * Lightweight event-sourced session entry point for modes and extensions.
 * It owns no transcript state; conversation data is read from EventStore
 * projections through EventSourcedRuntime.
 */

import { readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { EventBase, ImageContent, FileAttachment } from "./event-store/types.js";
import type { SubscribeOptions } from "./event-store/store.js";
import type { ExtensionRunner, ResolvedCommand } from "./extensions/index.js";
import { expandPromptTemplate } from "./prompt-templates.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionProjection } from "./projection/session-projection.js";
import type { SettingsManager } from "./settings-manager.js";
import { isPersistableThinkingLevel } from "./settings-manager.js";
import type { ModelConfig, ToolDefinition } from "./runtime/llm-types.js";
import type { RuntimeCompactOptions } from "./runtime/runtime.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";

export interface SessionFacadeConfig {
	runtime: EventSourcedRuntime;
	settingsManager: SettingsManager;
	extensionRunner?: ExtensionRunner;
	modelRegistry?: ModelRegistry;
	resourceLoader?: ResourceLoader;
	disposers?: Array<() => void>;
}

export type SessionFacadeEventListener = (event: EventBase) => void;

/** Render queued content (string or content blocks) as display text. */
function queuedContentToText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
				return (block as { text: string }).text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}


export class SessionFacade {
	readonly runtime: EventSourcedRuntime;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly modelRegistry: ModelRegistry | undefined;
	readonly resourceLoader: ResourceLoader | undefined;
	private disposers: Array<() => void>;
	private disposed = false;

	constructor(config: SessionFacadeConfig) {
		this.runtime = config.runtime;
		this.settingsManager = config.settingsManager;
		this.extensionRunner = config.extensionRunner;
		this.modelRegistry = config.modelRegistry;
		this.resourceLoader = config.resourceLoader;
		this.disposers = config.disposers ?? [];
	}

	subscribe(listener: SessionFacadeEventListener, options?: SubscribeOptions): () => void {
		return this.runtime.subscribe(listener, options);
	}

	/**
	 * `/<name> [args]` interception — the pre-event-sourced AgentSession ran
	 * this inside prompt()/steer()/followUp() and it was dropped in the
	 * refactor, so `/computer install`-style extension commands reached the
	 * model as plain text. Order matches the original:
	 *   1. extension commands execute in-process (no LLM turn)
	 *   2. the `input` extension event may transform or swallow the input
	 *   3. `/skill:<name>` and prompt templates expand to their file content
	 */
	async prompt(text: string, images?: ImageContent[], files?: FileAttachment[]): Promise<void> {
		if (await this.executeExtensionCommand(text)) return;

		let currentText = text;
		let currentImages = images;
		const runner = this.extensionRunner;
		if (runner?.hasHandlers("input")) {
			// The event-store and pi-ai ImageContent types describe the same
			// blocks but differ in the mime field name — cast at the boundary.
			const inputResult = await runner.emitInput(
				currentText,
				currentImages as unknown as import("@earendil-works/pi-ai/compat").ImageContent[] | undefined,
				"interactive",
			);
			if (inputResult.action === "handled") return;
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = (inputResult.images ?? currentImages) as unknown as ImageContent[] | undefined;
			}
		}

		return this.runtime.prompt(this.expandSlashText(currentText), currentImages, files);
	}

	steer(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		// Extension commands cannot be queued behind a running turn — execute
		// them immediately instead of steering the raw "/name" text into it.
		if (this.resolveExtensionCommand(text)) {
			void this.executeExtensionCommand(text);
			return;
		}
		this.runtime.steer(this.expandSlashText(text), images, files);
	}

	followUp(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		if (this.resolveExtensionCommand(text)) {
			void this.executeExtensionCommand(text);
			return;
		}
		this.runtime.followUp(this.expandSlashText(text), images, files);
	}

	/** Resolve `/name` (first token) to a registered extension command. */
	private resolveExtensionCommand(text: string): ResolvedCommand | undefined {
		const runner = this.extensionRunner;
		if (!runner || !text.startsWith("/")) return undefined;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return runner.getCommand(commandName);
	}

	/** Execute an extension command in-process. True when the input matched one. */
	private async executeExtensionCommand(text: string): Promise<boolean> {
		const command = this.resolveExtensionCommand(text);
		const runner = this.extensionRunner;
		if (!command || !runner) return false;
		const spaceIndex = text.indexOf(" ");
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
		try {
			await command.handler(args, runner.createCommandContext());
		} catch (error) {
			runner.emitError({
				extensionPath: `command:${command.name}`,
				event: "command",
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return true;
	}

	/** Expand `/skill:<name>` into its `<skill>` block; pass through when unknown. */
	private expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;
		const loader = this.resourceLoader;
		if (!loader) return text;
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		const skill = loader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text;
		try {
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${block}\n\n${args}` : block;
		} catch (error) {
			this.extensionRunner?.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: error instanceof Error ? error.message : String(error),
			});
			return text;
		}
	}

	/** Expand `/skill:` commands and `/name` prompt templates in user input. */
	private expandSlashText(text: string): string {
		if (!text.startsWith("/")) return text;
		let expanded = this.expandSkillCommand(text);
		const templates = this.resourceLoader?.getPrompts().prompts;
		if (templates && templates.length > 0) {
			expanded = expandPromptTemplate(expanded, [...templates]);
		}
		return expanded;
	}

	/** Queued steer/follow-up texts (for pending-message display). Empty when idle. */
	getQueuedMessages(): { steering: string[]; followUp: string[] } {
		const entries = this.runtime.pendingFollowUps;
		return {
			steering: entries.filter((e) => e.kind === "steer").map((e) => queuedContentToText(e.content)),
			followUp: entries.filter((e) => e.kind === "followUp").map((e) => queuedContentToText(e.content)),
		};
	}

	/**
	 * Queued entries WITH their source event ids — the id is the handle for
	 * per-item cancellation (GUI pending strip). Entries queued without a
	 * source event (rare: legacy replay) have no id and cannot be cancelled
	 * individually.
	 */
	getQueuedEntries(): Array<{ kind: "steer" | "followUp"; text: string; sourceEventId?: string }> {
		return this.runtime.pendingFollowUps.map((e) => ({
			kind: e.kind,
			text: queuedContentToText(e.content),
			sourceEventId: e.sourceEventId,
		}));
	}

	/** Cancel ONE queued entry by source event id. True when removed. */
	cancelQueuedMessage(sourceEventId: string): boolean {
		return this.runtime.cancelQueuedFollowUp(sourceEventId);
	}

	/**
	 * Promote ONE queued entry to a steer: interrupt the running turn and
	 * deliver it now instead of waiting for the turn to finish. True when the
	 * entry was found and injected.
	 */
	steerQueuedMessage(sourceEventId: string): boolean {
		return this.runtime.steerQueuedFollowUp(sourceEventId);
	}

	/** Clear the runtime's pending queue; returns the cleared texts by kind. */
	clearQueuedMessages(): { steering: string[]; followUp: string[] } {
		const cleared = this.runtime.clearQueuedFollowUps();
		return {
			steering: cleared.steering.map((e) => queuedContentToText(e.content)),
			followUp: cleared.followUp.map((e) => queuedContentToText(e.content)),
		};
	}

	abort(): void {
		this.runtime.abort();
	}

	compact(options?: RuntimeCompactOptions): void {
		this.runtime.compact(options);
	}

	waitForIdle(): Promise<void> {
		return this.runtime.waitForIdle();
	}

	get isRunning(): boolean {
		return this.runtime.isRunning;
	}

	get signal(): AbortSignal | undefined {
		return this.runtime.signal;
	}

	getProjection(): SessionProjection {
		return this.runtime.getProjection();
	}

	get model(): ModelConfig {
		return this.runtime.getModel();
	}

	set model(model: ModelConfig) {
		this.setModel(model);
	}

	setModel(model: ModelConfig | Model<any>, thinkingLevel?: string): void {
		const modelId = "model_id" in model ? model.model_id : model.id;
		this.runtime.setModel(model.provider, modelId);
		this.persistModel(model.provider, modelId);

		const nextThinkingLevel = thinkingLevel ?? ("thinking_level" in model ? model.thinking_level : undefined);
		if (nextThinkingLevel !== undefined) {
			this.runtime.setThinkingLevel(nextThinkingLevel);
			this.persistThinkingLevel(nextThinkingLevel);
		}
	}

	get thinkingLevel(): string | undefined {
		return this.runtime.getThinkingLevel();
	}

	set thinkingLevel(level: string | undefined) {
		if (level !== undefined) {
			this.runtime.setThinkingLevel(level);
			this.persistThinkingLevel(level);
		}
	}

	/**
	 * Persist the user's model choice as the global default so the next sidecar
	 * launch picks it up. Best-effort: a settings-write error is warned but never
	 * thrown, because the in-memory state has already been updated by
	 * `runtime.setModel` above and we don't want to break the current turn over
	 * a disk-side failure.
	 */
	private persistModel(provider: string, modelId: string): void {
		try {
			this.settingsManager.setDefaultModelAndProvider(provider, modelId);
		} catch (e) {
			console.warn(
				`[pizza] failed to persist model preference (${provider}/${modelId}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	/**
	 * Persist the user's thinking-level choice as the global default. Same
	 * best-effort semantics as {@link persistModel}. The `as never` cast avoids
	 * pulling the ThinkingLevel union into this file just for the setter type.
	 */
	private persistThinkingLevel(level: string): void {
		try {
			this.settingsManager.setDefaultThinkingLevel(level as never);
		} catch (e) {
			console.warn(
				`[pizza] failed to persist thinking-level preference (${level}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	get tools(): ToolDefinition[] {
		return this.runtime.getTools();
	}

	set tools(tools: ToolDefinition[]) {
		this.runtime.setTools(tools);
	}

	get systemPrompt(): string {
		return this.runtime.getSystemPrompt();
	}

	set systemPrompt(prompt: string) {
		this.runtime.setSystemPrompt(prompt);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const dispose of this.disposers.splice(0)) {
			dispose();
		}
		this.runtime.dispose();
	}
}