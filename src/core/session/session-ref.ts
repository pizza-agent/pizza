import { basename, dirname } from "node:path";
import { getAgentDir as getDefaultAgentDir } from "../../config.js";

export const SESSION_REF_PREFIX = "event-session:";

export function makeSessionRef(workspaceId: string, sessionId: string): string {
	return `${SESSION_REF_PREFIX}${workspaceId}:${sessionId}`;
}

export function parseSessionRef(ref: string): { workspaceId?: string; sessionId: string } {
	if (ref.endsWith(".jsonl") || ref.includes("/") || ref.includes("\\")) {
		throw new Error("Legacy JSONL session files are no longer supported; sessions now live in events.sqlite.");
	}
	if (!ref.startsWith(SESSION_REF_PREFIX)) {
		return { sessionId: ref };
	}
	const rest = ref.slice(SESSION_REF_PREFIX.length);
	const [workspaceId, sessionId] = rest.split(":");
	if (!sessionId) {
		throw new Error(`Invalid session reference: ${ref}`);
	}
	return { workspaceId, sessionId };
}

export function getAgentDirFromSessionDir(sessionDir?: string): string {
	if (!sessionDir) return getDefaultAgentDir();
	return basename(sessionDir) === "sessions" ? dirname(sessionDir) : sessionDir;
}
