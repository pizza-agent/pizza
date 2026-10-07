/**
 * Scheduled tasks are stored per sidecar: the main agent writes to
 * `~/.pizza/main/scheduler`, every other workspace to
 * `~/.pizza/workspaces/<id>/scheduler`. So a task list is always scoped to the
 * workspace the UI is currently attached to, and the RPC layer rejects
 * mismatched scope/workspace pairs. This helper derives that pair from the
 * active workspace cwd so every caller (Schedules page, composer popover)
 * asks for exactly one workspace's tasks.
 */
import { isMainChatCwd, normalizePathForCompare } from "./platform";

export interface ScheduleScope {
	scope: "main" | "workspace";
	workspaceId?: string;
}

export function resolveScheduleScope(workspace?: string | null): ScheduleScope {
	const cwd = normalizePathForCompare(workspace ?? "");
	if (isMainChatCwd(cwd)) return { scope: "main" };
	return { scope: "workspace", workspaceId: cwd || undefined };
}
