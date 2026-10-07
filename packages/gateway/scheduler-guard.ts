/**
 * Gateway scheduler guard — the single owner of "a workspace with runnable
 * scheduled tasks must have a live agent".
 *
 * History: the desktop GUI used to keep its own per-cwd sidecars alive after
 * window close (and re-spawn them from a 15s Rust loop) so cron tasks kept
 * firing. Those sidecars were invisible to the gateway pool and their pids
 * died with the GUI's memory — a GUI restart produced orphan agents and TWO
 * SchedulerEngines dispatching the same tasks.
 *
 * Now the gateway (already a detached daemon that outlives the GUI) owns this:
 * every guard tick it scans all scheduler scopes on disk, and
 *   1. reports the set of scheduled cwds — the pool pins these agents so idle
 *      eviction skips them, and
 *   2. the pool spawns an agent for any scheduled cwd that has none.
 *
 * Each spawned agent runs its own SchedulerEngine for its scope (rpc-mode
 * always builds one), and the engine's cross-process scope lock guarantees a
 * single dispatcher per scope even if some other process lingers.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readTasks } from "../../src/core/scheduler/store.js";
import { listKnownWorkspaces } from "../../src/core/event-store/workspace.js";
import type { ScheduledTask } from "@tomsun28/pizza-protocol";

/**
 * Can this task ever fire? Mirrors the engine's gating: it must be enabled,
 * have a supported session target, and not be exhausted by its maxRuns cap.
 */
function isRunnable(task: ScheduledTask): boolean {
	if (!task.enabled) return false;
	const target = task.sessionTarget;
	if (!target || target.kind === "current") return false;
	if (target.kind === "pinned" && !target.sessionId) return false;
	if (typeof task.maxRuns === "number" && task.maxRuns > 0 && (task.runCount ?? 0) >= task.maxRuns) {
		return false;
	}
	return true;
}

/** Normalize a cwd for set-membership comparisons using the platform-native absolute form. */
export function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

/**
 * Scan every scheduler scope on disk and return the cwds that must have a
 * live agent (normalized). `agentDir` locates workspace metas (cwd mapping);
 * `mainDir` is the main agent's cwd (its tasks live in the "main" scope).
 */
export function scheduledCwdsOnDisk(agentDir: string, mainDir?: string): Set<string> {
	const out = new Set<string>();

	// Main scope → the main agent's cwd.
	if (mainDir && readTasks("main").some(isRunnable)) {
		out.add(normalizeCwd(mainDir));
	}

	// Workspace scopes: workspace_id → cwd via the agent-dir metas.
	for (const ws of listKnownWorkspaces(agentDir)) {
		if (!ws.cwd || !existsSync(ws.cwd)) continue;
		try {
			if (readTasks("workspace", ws.workspace_id).some(isRunnable)) {
				out.add(normalizeCwd(ws.cwd));
			}
		} catch {
			// Unreadable scheduler dir — skip, never break the guard tick.
		}
	}
	return out;
}