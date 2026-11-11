/**
 * Tool Adapter
 *
 * Adapts legacy AgentTool instances to the new ToolExecutor / ToolRegistry
 * interface used by the event-sourced runtime.
 *
 * Key responsibilities:
 * - Convert AgentTool.execute(toolCallId, params, signal, onUpdate) → ToolExecutor.execute(args, options)
 * - Detect file mutations from tool results and populate file_mutations
 * - Build a ToolRegistry from an array of AgentTools
 */

import type { AgentTool } from "../agent/types.js";
import type {
	IntentCategory,
	IntentRisk,
	ResolvedToolCall,
	ToolExecutionOptions,
	ToolExecutionResult,
	ToolExecutor,
	ToolMetadata,
	ToolRegistry,
} from "./types.js";
import type { FileMutation } from "../event-store/types.js";
import type { CliToolDetails } from "../tools/cli.js";
import { validateToolArguments } from "../tools/argument-validation.js";

// ============================================================================
// File Mutation Detection
// ============================================================================

/**
 * Infer file mutations from a tool execution: the cli tool's `_write` /
 * `_edit` commands report their target path. Shell commands cannot be
 * detected reliably and are not reported.
 */
function inferFileMutations(toolName: string, result: ToolExecutionResult): FileMutation[] | undefined {
	if (toolName !== "cli") return undefined;
	const command = (result.details as CliToolDetails | undefined)?.command;
	if (command?.source !== "builtin") return undefined;
	const path = (command.args as { path?: string } | undefined)?.path;
	if (!path) return undefined;
	if (command.name === "_write") return [{ path, operation: "create" }];
	if (command.name === "_edit") return [{ path, operation: "modify" }];
	return undefined;
}

// ============================================================================
// Tool Category Mapping
// ============================================================================

/** Map AgentTool name to IntentCategory */
function inferCategory(toolName: string): IntentCategory {
	return toolName === "cli" ? "shell_moderate" : "unknown";
}

/** Map category to default risk */
function inferRisk(category: IntentCategory): IntentRisk {
	switch (category) {
		case "file_read":
		case "shell_safe":
			return "safe";
		case "file_write":
		case "shell_moderate":
		case "network":
			return "moderate";
		case "file_delete":
		case "shell_dangerous":
		case "unknown":
			return "dangerous";
	}
}

// ============================================================================
// ToolExecutor Adapter
// ============================================================================

/**
 * Wraps a legacy AgentTool as a ToolExecutor for the event-sourced runtime.
 */
export class AgentToolAdapter implements ToolExecutor {
	private metadata: ToolMetadata;
	private preparedCalls = new Map<string, { raw: string; normalized: string; args: Record<string, unknown> }>();

	constructor(private tool: AgentTool<any, any>) {
		const category = inferCategory(tool.name);
		this.metadata = {
			name: tool.name,
			description: tool.description,
			category,
			defaultRisk: inferRisk(category),
			...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		};
	}

	async execute(args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<ToolExecutionResult> {
		const toolCallId = options?.tool_call_id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		try {
			if (options?.signal?.aborted) throw new Error("Operation aborted before execution");
			const prepared = options?.arguments_prepared ? args : this.prepareArguments(args, toolCallId);
			if (options?.arguments_prepared) validateToolArguments(this.tool.parameters, prepared);
			this.preparedCalls.delete(toolCallId);
			const result = await this.tool.execute(toolCallId, prepared, options?.signal, options?.onUpdate);

			const executionResult: ToolExecutionResult = {
				content: result.content.map((block) => ({ ...block })),
				details: result.details,
				is_error: false,
			};

			// Detect file mutations
			const mutations = inferFileMutations(this.tool.name, executionResult);
			if (mutations?.length) {
				executionResult.file_mutations = mutations;
			}

			return executionResult;
		} catch (err) {
			this.preparedCalls.delete(toolCallId);
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: msg }],
				is_error: true,
				error_message: msg,
			};
		}
	}

	prepareArguments(args: Record<string, unknown>, toolCallId: string): Record<string, unknown> {
		const raw = JSON.stringify(args);
		const cached = this.preparedCalls.get(toolCallId);
		if (cached && (raw === cached.raw || raw === cached.normalized)) return structuredClone(cached.args);
		const prepared = this.tool.prepareArguments ? this.tool.prepareArguments(structuredClone(args)) : args;
		validateToolArguments(this.tool.parameters, prepared);
		this.preparedCalls.set(toolCallId, { raw, normalized: JSON.stringify(prepared), args: structuredClone(prepared) });
		if (this.preparedCalls.size > 256) this.preparedCalls.delete(this.preparedCalls.keys().next().value!);
		return structuredClone(prepared);
	}

	resolve(args: Record<string, unknown>, toolCallId: string): ResolvedToolCall | undefined {
		return this.tool.resolve?.(this.prepareArguments(args, toolCallId), toolCallId);
	}

	getMetadata(): ToolMetadata {
		return this.metadata;
	}
}

// ============================================================================
// ToolRegistry from AgentTools
// ============================================================================

/**
 * Build a ToolRegistry from an array of AgentTool instances.
 *
 * Usage:
 *   const tools = createTools(cwd, options);
 *   const registry = createToolRegistry(tools);
 */
export function createToolRegistry(tools: AgentTool<any, any>[]): ToolRegistry {
	const executors = new Map<string, ToolExecutor>();

	for (const tool of tools) {
		executors.set(tool.name, new AgentToolAdapter(tool));
	}

	return {
		get(name: string) {
			return executors.get(name);
		},
		list() {
			return Array.from(executors.keys());
		},
	};
}
