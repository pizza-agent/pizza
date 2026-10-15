/**
 * Tool assembly phase for createSessionFacade.
 *
 * Owns the mutable "which tools are available / active" state that used to
 * live in factory closure variables, plus the derived system prompt. Pushes
 * updates into the runtime when one is attached.
 */

import type { ToolDefinition as ExtensionToolDefinition, ToolInfo } from "../extensions/index.js";
import type { ExtensionRunner } from "../extensions/index.js";
import type { ToolDefinition as RuntimeToolDefinition } from "../runtime/llm-types.js";
import type { EventSourcedRuntime } from "../runtime/runtime.js";
import { createSyntheticSourceInfo } from "../skills/source-info.js";
import { allToolNames, createToolDefinition, type ToolName } from "../tools/index.js";
import type { PromptBuilder } from "./prompt-builder.js";

function isBuiltInToolName(name: string): name is ToolName {
	return allToolNames.has(name as ToolName);
}

export function toRuntimeToolDefinition(definition: ExtensionToolDefinition): RuntimeToolDefinition {
	return {
		name: definition.name,
		description: definition.description ?? "",
		input_schema: definition.parameters as unknown as Record<string, unknown>,
	};
}

export interface ToolAssemblyDeps {
	cwd: string;
	requestedToolNames: string[];
	/** When set, only these tool names are exposed (options.tools allowlist). */
	allowedToolNames: Set<string> | undefined;
	toolOptions: Parameters<typeof createToolDefinition>[2];
	extensionRunner: ExtensionRunner;
	customTools: ExtensionToolDefinition[];
	buildPrompt: PromptBuilder;
}

export class ToolAssembly {
	private _available: ExtensionToolDefinition[] = [];
	private _active: ExtensionToolDefinition[] = [];
	private _sources = new Map<string, ToolInfo["sourceInfo"]>();
	private _systemPrompt = "";
	private _runtime: EventSourcedRuntime | undefined;

	constructor(private readonly deps: ToolAssemblyDeps) {}

	/** Attach the runtime so later tool/prompt changes are pushed into it. */
	attachRuntime(runtime: EventSourcedRuntime): void {
		this._runtime = runtime;
	}

	get availableToolDefinitions(): ExtensionToolDefinition[] {
		return this._available;
	}

	get activeToolDefinitions(): ExtensionToolDefinition[] {
		return this._active;
	}

	get systemPrompt(): string {
		return this._systemPrompt;
	}

	get activeToolNames(): string[] {
		return this._active.map((definition) => definition.name);
	}

	get runtimeToolDefinitions(): RuntimeToolDefinition[] {
		return this._active.map(toRuntimeToolDefinition);
	}

	private _include(name: string): boolean {
		return !this.deps.allowedToolNames || this.deps.allowedToolNames.has(name);
	}

	private _buildAvailable(): void {
		const definitions = new Map<string, ExtensionToolDefinition>();
		const sources = new Map<string, ToolInfo["sourceInfo"]>();

		for (const name of this.deps.requestedToolNames) {
			if (!isBuiltInToolName(name) || !this._include(name)) continue;
			// The cli tool additionally routes extension-registered dynamic built-in
			// commands (e.g. computer-use's _computer_use); wire the lazy provider
			// here so the tool sees commands from every loaded extension.
			const toolOptions =
				name === "cli"
					? {
							...this.deps.toolOptions,
							cli: {
								...this.deps.toolOptions?.cli,
								dynamicBuiltins: () => this.deps.extensionRunner.getAllRegisteredBuiltinCommands(),
							},
						}
					: this.deps.toolOptions;
			const definition = createToolDefinition(name, this.deps.cwd, toolOptions);
			definitions.set(definition.name, definition);
			sources.set(definition.name, createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }));
		}

		for (const tool of this.deps.extensionRunner.getAllRegisteredTools()) {
			if (!this._include(tool.definition.name)) continue;
			definitions.set(tool.definition.name, tool.definition);
			sources.set(tool.definition.name, tool.sourceInfo);
		}

		for (const definition of this.deps.customTools) {
			if (!this._include(definition.name)) continue;
			definitions.set(definition.name, definition);
			sources.set(definition.name, createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }));
		}
		this._available = Array.from(definitions.values());
		this._sources = sources;
	}

	/**
	 * Rebuild the available tool set, select the active subset (all available
	 * when toolNames is omitted), rebuild the system prompt, and push both
	 * into the runtime when attached.
	 */
	applyActiveTools(toolNames?: string[]): void {
		this._buildAvailable();
		const activeNames = toolNames ? new Set(toolNames) : undefined;
		this._active = activeNames
			? this._available.filter((definition) => activeNames.has(definition.name))
			: [...this._available];
		this._systemPrompt = this.deps.buildPrompt(this._active);

		if (this._runtime) {
			this._runtime.setTools(this.runtimeToolDefinitions);
			this._runtime.setSystemPrompt(this._systemPrompt);
		}
	}

	/**
	 * Rebuild only the system prompt (e.g. the session-position breadcrumb
	 * changed after split/fork/jump) without rebuilding the tool set.
	 */
	refreshSystemPrompt(): string {
		this._systemPrompt = this.deps.buildPrompt(this._active);
		if (this._runtime) {
			// Silent: this is a rebuild (breadcrumbs/tool docs drift per
			// turn), not a user config change — applyActiveTools() is the
			// canonical mutation point that logs USER_CONFIG_CHANGE.
			this._runtime.setSystemPrompt(this._systemPrompt, { silent: true });
		}
		return this._systemPrompt;
	}

	getToolInfos(): ToolInfo[] {
		return this._available.map((definition) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo:
				this._sources.get(definition.name) ??
				createSyntheticSourceInfo(`<tool:${definition.name}>`, { source: "unknown" }),
		}));
	}
}