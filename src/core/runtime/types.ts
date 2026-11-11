import type { EventBase } from "../event-store/types.js";
import type { ToolExecutionResult, ToolExecutionUpdate } from "../intent/types.js";

export type RuntimeKind = "local" | "cloud" | "container";

export interface ToolExecutionRequest {
	tool_call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
	arguments_prepared?: boolean;
	execution_mode?: "sequential" | "parallel";
	caused_by?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: ToolExecutionUpdate) => void;
}

export interface CheckpointRequest {
	cwd: string;
	event_head?: string;
	event_head_sequence?: number;
	label?: string;
}

export interface CheckpointRef {
	checkpoint_id: string;
	path: string;
	created_at: number;
	event_head?: string;
	event_head_sequence?: number;
	label?: string;
}

export interface RuntimeStatus {
	runtime_id: string;
	workspace_id: string;
	kind: RuntimeKind;
	cwd: string;
	status: "idle" | "running" | "paused" | "error";
}

export interface RuntimeAdapter {
	readonly runtime_id: string;
	readonly workspace_id: string;
	readonly kind: RuntimeKind;

	executeTool(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
	createCheckpoint(request: CheckpointRequest): Promise<CheckpointRef>;
	restoreCheckpoint(ref: CheckpointRef): Promise<void>;
	getStatus(): Promise<RuntimeStatus>;
	subscribeEvents?(after?: string): AsyncIterable<EventBase>;
}
