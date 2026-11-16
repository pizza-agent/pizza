/**
 * File-change helpers shared by the conversation timeline and the Changes view.
 *
 * The reactor emits `FILE_MUTATION_APPLIED` for file writes/edits, and also
 * attaches the same mutations to `TOOL_EXECUTION_END`. Both paths are fed
 * through these helpers so the UI can dedupe them and keep one stable change
 * per tool call/path.
 */

export type FileChangeOperation = "create" | "modify" | "delete";

export interface FileChange {
	/** Workspace-relative path, normalized to forward slashes. */
	path: string;
	operation: FileChangeOperation;
	/** Unified diff, when the runtime provided one. */
	diff?: string;
	/** Undefined when the runtime did not provide a diff; do not render +0 −0. */
	additions?: number;
	deletions?: number;
	/** Tool call that produced the change, for attaching it to a tool card. */
	toolCallId?: string;
	toolName?: string;
}

interface RawMutation {
	path?: unknown;
	operation?: unknown;
	diff?: unknown;
	additions?: unknown;
	deletions?: unknown;
	tool_call_id?: unknown;
	toolCallId?: unknown;
	tool_name?: unknown;
	toolName?: unknown;
}

function normalizePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const path = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
	return path.length > 0 ? path : null;
}

function normalizeOperation(value: unknown): FileChangeOperation {
	const op = typeof value === "string" ? value.toLowerCase() : "";
	if (op === "create" || op === "add" || op === "new" || op === "write") return "create";
	if (op === "delete" || op === "remove" || op === "deleted") return "delete";
	return "modify";
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Count unified-diff additions/deletions inside hunks. */
export function countDiffStats(diff: string | undefined): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	if (!diff) return { additions, deletions };
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		// A hunk line is content even when it begins with "+++" (adding `++i`)
		// or "---" (removing `--x`). Only the pre-hunk file headers are excluded.
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

/** Normalize one raw mutation object from a tool result or event payload. */
export function parseFileChange(raw: unknown, fallbackToolCallId?: string, fallbackToolName?: string): FileChange | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as RawMutation & { mutation?: RawMutation };
	// Older events nested the mutation under `mutation`; current events are flat.
	const mutation = source.path === undefined && source.mutation ? source.mutation : source;
	const path = normalizePath(mutation.path);
	if (!path) return null;
	const diff = typeof mutation.diff === "string" && mutation.diff.length > 0 ? mutation.diff : undefined;
	const counted = diff ? countDiffStats(diff) : undefined;
	const additions = finiteNumber(mutation.additions) ?? counted?.additions;
	const deletions = finiteNumber(mutation.deletions) ?? counted?.deletions;
	const toolCallIdRaw =
		source.tool_call_id ?? source.toolCallId ?? mutation.tool_call_id ?? mutation.toolCallId ?? fallbackToolCallId;
	const toolNameRaw =
		source.tool_name ?? source.toolName ?? mutation.tool_name ?? mutation.toolName ?? fallbackToolName;
	return {
		path,
		operation: normalizeOperation(mutation.operation),
		...(diff ? { diff } : {}),
		...(additions !== undefined ? { additions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
		...(typeof toolCallIdRaw === "string" && toolCallIdRaw.length > 0 ? { toolCallId: toolCallIdRaw } : {}),
		...(typeof toolNameRaw === "string" && toolNameRaw.length > 0 ? { toolName: toolNameRaw } : {}),
	};
}

/** Read `TOOL_EXECUTION_END.payload.file_mutations`. */
export function fileChangesFromToolEnd(payload: unknown): FileChange[] {
	if (!payload || typeof payload !== "object") return [];
	const record = payload as { file_mutations?: unknown; tool_call_id?: unknown; tool_name?: unknown };
	if (!Array.isArray(record.file_mutations)) return [];
	const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
	const toolName = typeof record.tool_name === "string" ? record.tool_name : undefined;
	return record.file_mutations
		.map((mutation) => parseFileChange(mutation, toolCallId, toolName))
		.filter((change): change is FileChange => change !== null);
}

/** Read one `FILE_MUTATION_APPLIED.payload`. */
export function fileChangeFromMutationEvent(payload: unknown): FileChange | null {
	return parseFileChange(payload);
}

/** Identity shared by a tool-end mutation and its corresponding applied event. */
function changeIdentity(change: FileChange): string {
	return `${change.toolCallId ?? ""}|${change.path}|${change.operation}`;
}

/**
 * Merge new changes from both runtime paths.
 *
 * `TOOL_EXECUTION_END.file_mutations` may carry only path/operation while the
 * matching `FILE_MUTATION_APPLIED` also carries the diff. Merge those into one
 * richer card; keep genuinely different diffs as separate edits.
 */
export function mergeFileChanges(existing: FileChange[] | undefined, incoming: FileChange[]): FileChange[] {
	const out = existing ? [...existing] : [];
	for (const change of incoming) {
		const index = out.findIndex((current) => changeIdentity(current) === changeIdentity(change));
		if (index < 0) {
			out.push(change);
			continue;
		}
		const current = out[index];
		if (current.diff && change.diff && current.diff !== change.diff) {
			out.push(change);
			continue;
		}
		if (!current.diff && change.diff) {
			out[index] = {
				...current,
				...change,
				additions: change.additions ?? current.additions,
				deletions: change.deletions ?? current.deletions,
			};
		} else {
			out[index] = {
				...current,
				additions: current.additions ?? change.additions,
				deletions: current.deletions ?? change.deletions,
			};
		}
	}
	return out;
}

/** Select mutation events belonging to one thread before attaching them to history. */
export function fileChangesForThread(
	events: Array<{ thread_id?: string; payload: unknown }>,
	threadId: string,
): FileChange[] {
	return events
		.filter((event) => event.thread_id === threadId)
		.map((event) => fileChangeFromMutationEvent(event.payload))
		.filter((change): change is FileChange => change !== null);
}
