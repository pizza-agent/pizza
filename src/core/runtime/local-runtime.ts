import { join } from "node:path";
import type { ToolExecutionResult, ToolRegistry } from "../intent/types.js";
import { getWorkspaceDir } from "../event-store/workspace.js";
import { LocalCheckpointService } from "./checkpoint.js";
import type {
	CheckpointRef,
	CheckpointRequest,
	RuntimeAdapter,
	RuntimeKind,
	RuntimeStatus,
	ToolExecutionRequest,
} from "./types.js";

export interface LocalRuntimeAdapterOptions {
	runtime_id?: string;
	workspace_id: string;
	cwd: string;
	agentDir?: string;
	toolRegistry: ToolRegistry;
}

export class LocalRuntimeAdapter implements RuntimeAdapter {
	readonly runtime_id: string;
	readonly workspace_id: string;
	readonly kind: RuntimeKind = "local";
	private checkpointService: LocalCheckpointService | undefined;
	private status: RuntimeStatus["status"] = "idle";
	private toolBarrier: Promise<void> = Promise.resolve();
	private parallelTools = new Set<Promise<void>>();
	private activeTools = 0;

	constructor(private options: LocalRuntimeAdapterOptions) {
		this.runtime_id = options.runtime_id ?? "local_runtime";
		this.workspace_id = options.workspace_id;
	}

	async executeTool(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
		const tool = this.options.toolRegistry.get(request.tool_name);
		if (!tool) {
			return {
				content: [{ type: "text", text: `Unknown tool: ${request.tool_name}` }],
				is_error: true,
				error_message: `Unknown tool: ${request.tool_name}`,
			};
		}

		const run = async (): Promise<ToolExecutionResult> => {
			if (request.signal?.aborted) {
				return {
					content: [{ type: "text", text: "Operation aborted before execution" }],
					is_error: true, error_message: "Operation aborted before execution",
				};
			}
			this.activeTools++;
			this.status = "running";
			try {
				return await tool.execute(request.arguments, {
					tool_call_id: request.tool_call_id,
					arguments_prepared: request.arguments_prepared,
					signal: request.signal,
					onUpdate: request.onUpdate,
				});
			} finally {
				if (--this.activeTools === 0) this.status = "idle";
			}
		};
		const sequential = (request.execution_mode ?? tool.getMetadata().executionMode) === "sequential";
		const preceding = sequential ? Promise.all([this.toolBarrier, ...this.parallelTools]) : this.toolBarrier;
		const result = preceding.then(run);
		const settled = result.then(() => {}, () => {});
		if (sequential) this.toolBarrier = settled;
		else {
			this.parallelTools.add(settled);
			void settled.then(() => this.parallelTools.delete(settled));
		}
		return result;
	}

	async createCheckpoint(request: CheckpointRequest): Promise<CheckpointRef> {
		return this._getCheckpointService().create(request);
	}

	async restoreCheckpoint(ref: CheckpointRef): Promise<void> {
		this._getCheckpointService().restore(ref);
	}

	async getStatus(): Promise<RuntimeStatus> {
		return {
			runtime_id: this.runtime_id,
			workspace_id: this.workspace_id,
			kind: this.kind,
			cwd: this.options.cwd,
			status: this.status,
		};
	}

	private _getCheckpointService(): LocalCheckpointService {
		if (!this.checkpointService) {
			const workspaceDir = getWorkspaceDir(this.options.workspace_id, this.options.agentDir);
			this.checkpointService = new LocalCheckpointService({
				workspace_id: this.options.workspace_id,
				runtime_id: this.runtime_id,
				checkpointDir: join(workspaceDir, "checkpoints"),
			});
		}
		return this.checkpointService;
	}
}
