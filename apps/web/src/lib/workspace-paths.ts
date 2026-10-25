/**
 * Workspace path registry.
 *
 * Remote workspaces use a synthetic `remote://` key for UI routing, while
 * commands executed by the remote Pizza process need the actual remote path.
 */

const workspacePaths = new Map<string, string>();

export function setWorkspacePaths(
	entries: Array<{ cwd: string; kind?: "local" | "remote"; remote?: { remote_path: string } }>,
): void {
	workspacePaths.clear();
	for (const entry of entries) {
		if (entry.kind === "remote" && entry.remote?.remote_path) {
			workspacePaths.set(entry.cwd, entry.remote.remote_path);
		}
	}
}

export function resolveWorkspaceExecutionPath(workspace?: string | null): string {
	return workspacePaths.get(workspace ?? "") ?? workspace ?? "";
}
