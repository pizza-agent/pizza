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

	constructor(private tool: AgentTool<any, any>) {
		const category = inferCategory(tool.name);
		this.metadata = {
			name: tool.name,
			description: tool.description,
			category,
			defaultRisk: inferRisk(category),
		};
	}

	async execute(args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<ToolExecutionResult> {
		const toolCallId = options?.tool_call_id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		// Prepare arguments if the tool has a prepareArguments hook
		const prepared = this.tool.prepareArguments ? this.tool.prepareArguments(args) : args;

		try {
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
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: msg }],
				is_error: true,
				error_message: msg,
			};
		}
	}

	resolve(args: Record<string, unknown>, toolCallId: string): ResolvedToolCall | undefined {
		return this.tool.resolve?.(args, toolCallId);
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
