/**
 * Scheduled tasks execute inside the remote Pizza process, so the RPC scope
 * must use the real remote directory rather than the desktop's synthetic key.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resolveScheduleScope } from "../apps/web/src/lib/schedule-scope.js";
import { setWorkspacePaths } from "../apps/web/src/lib/workspace-paths.js";

describe("remote schedule scope", () => {
	afterEach(() => setWorkspacePaths([]));

	it("maps a synthetic remote workspace key to its remote execution path", () => {
		setWorkspacePaths([
			{
				cwd: "remote://abc123",
				kind: "remote",
				remote: { remote_path: "/srv/projects/pizza" },
			},
			{ cwd: "/Users/me/project", kind: "local" },
		]);

		expect(resolveScheduleScope("remote://abc123")).toEqual({
			scope: "workspace",
			workspaceId: "/srv/projects/pizza",
		});
		expect(resolveScheduleScope("/Users/me/project")).toEqual({
			scope: "workspace",
			workspaceId: "/Users/me/project",
		});
	});
});
