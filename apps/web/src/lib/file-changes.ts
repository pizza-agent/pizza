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

/** Count unified-diff additions/deletions, excluding file headers. */
export function countDiffStats(diff: string | undefined): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	if (!diff) return { additions, deletions };
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function changeKey(change: FileChange): string {
	return [
		change.toolCallId ?? "",
		change.path,
		change.operation,
		change.diff ? hashText(change.diff) : `${change.additions ?? ""}:${change.deletions ?? ""}`,
	].join("|");
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
	const counted = countDiffStats(diff);
	const toolCallIdRaw =
		source.tool_call_id ?? source.toolCallId ?? mutation.tool_call_id ?? mutation.toolCallId ?? fallbackToolCallId;
	const toolNameRaw =
		source.tool_name ?? source.toolName ?? mutation.tool_name ?? mutation.toolName ?? fallbackToolName;
	return {
		path,
		operation: normalizeOperation(mutation.operation),
		...(diff ? { diff } : {}),
		additions: finiteNumber(mutation.additions) ?? counted.additions,
		deletions: finiteNumber(mutation.deletions) ?? counted.deletions,
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

/** Merge new changes, dropping exact duplicates (payload + event can both carry one). */
export function mergeFileChanges(existing: FileChange[] | undefined, incoming: FileChange[]): FileChange[] {
	const out = existing ? [...existing] : [];
	const seen = new Set(out.map(changeKey));
	for (const change of incoming) {
		const key = changeKey(change);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(change);
	}
	return out;
}
