/**
 * Tool-result masking (observation masking).
 *
 * The cheapest compaction tier: replace large, old tool results with a short
 * placeholder and clear stale tool-call argument payloads, while keeping the
 * user/assistant message and tool-call structure intact. Applied at projection
 * time — events in the store are never modified.
 */

import type { ContentBlock, EventBase } from "../event-store/types.js";
import type { ToolExecutionEndEvent } from "../event-store/events.js";

/** Tool results shorter than this (in chars) are kept verbatim. */
export const DEFAULT_MASK_MIN_CHARS = 500;

const IMAGE_CHARS = 4800;
const MAX_ARGS_CHARS = 200;
const MAX_TOOL_ARG_VALUE_CHARS = 500;

export interface MaskCompactionPayload {
	mode: "mask";
	mask_before_event_id: string;
	mask_min_chars?: number;
}

export function isMaskCompaction(event: EventBase): boolean {
	return event.type === "COMPACTION_END" && (event.payload as { mode?: string }).mode === "mask";
}

export function toolResultChars(result: ContentBlock[]): number {
	let chars = 0;
	for (const block of result) {
		if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
	}
	return chars;
}

/**
 * Replace TOOL_EXECUTION_END results older than `beforeSequence` and at least
 * `minChars` long with a placeholder. Unchanged events are returned by identity.
 */
export function maskToolResultEvents(
	events: EventBase[],
	beforeSequence: number,
	minChars = DEFAULT_MASK_MIN_CHARS,
): EventBase[] {
	const calls = collectToolCalls(events);
	return events.map((event) => {
		if (event.type !== "TOOL_EXECUTION_END" || event.sequence >= beforeSequence) return event;
		const payload = event.payload as ToolExecutionEndEvent["payload"];
		const chars = toolResultChars(payload.result ?? []);
		if (chars < minChars) return event;
		const text = buildPlaceholder(payload.tool_name, calls.get(payload.tool_call_id), chars);
		return { ...event, payload: { ...payload, result: [{ type: "text", text }] } };
	});
}

/**
 * Clear large arguments of completed tool calls older than `beforeSequence`.
 *
 * Tool results are only half of the observation payload: an old `_write` or
 * `_edit` call can carry an entire file in its arguments and would otherwise
 * be resent on every turn. Keep the call id, name, and short fields such as
 * `path` / `op`; replace only values that are large enough to matter.
 */
export function maskToolCallArgumentEvents(
	events: EventBase[],
	beforeSequence: number,
	minChars = DEFAULT_MASK_MIN_CHARS,
): EventBase[] {
	const completed = collectCompletedToolCalls(events, beforeSequence);
	return events.map((event) => {
		if (event.type !== "AGENT_MESSAGE_END" || event.sequence >= beforeSequence) return event;
		const payload = event.payload as { content?: unknown[] };
		if (!Array.isArray(payload.content)) return event;

		let changed = false;
		const content = payload.content.map((block) => {
			if (!block || typeof block !== "object") return block;
			const call = block as { type?: string; id?: string; tool_call_id?: string; arguments?: unknown };
			if (call.type !== "tool_call" && call.type !== "toolCall") return block;
			const id = call.id ?? call.tool_call_id;
			if (!id || !completed.has(String(id))) return block;
			const args = call.arguments as Record<string, unknown> | undefined;
			if (!args) return block;
			const before = JSON.stringify(args) ?? "";
			if (before.length < minChars) return block;
			const compacted = compactToolCallArguments(args);
			if ((JSON.stringify(compacted) ?? "").length >= before.length) return block;
			changed = true;
			return { ...call, arguments: compacted };
		});
		return changed ? { ...event, payload: { ...payload, content } } : event;
	});
}

function collectCompletedToolCalls(events: EventBase[], beforeSequence: number): Set<string> {
	const completed = new Set<string>();
	for (const event of events) {
		if (event.type !== "TOOL_EXECUTION_END" || event.sequence >= beforeSequence) continue;
		const id = (event.payload as ToolExecutionEndEvent["payload"]).tool_call_id;
		if (id) completed.add(String(id));
	}
	return completed;
}

function compactToolCallArguments(args: Record<string, unknown>): Record<string, unknown> {
	const compact: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const serialized = JSON.stringify(value) ?? "undefined";
		if (serialized.length <= MAX_TOOL_ARG_VALUE_CHARS) {
			compact[key] = value;
		} else if (typeof value === "string") {
			const omitted = serialized.length - MAX_TOOL_ARG_VALUE_CHARS;
			compact[key] = `${value.slice(0, MAX_TOOL_ARG_VALUE_CHARS)}[... ${omitted} chars cleared from old context]`;
		} else {
			compact[key] = `[cleared from old context: ${serialized.length} chars]`;
		}
	}
	return compact;
}

function collectToolCalls(events: EventBase[]): Map<string, Record<string, unknown>> {
	const calls = new Map<string, Record<string, unknown>>();
	for (const event of events) {
		if (event.type !== "AGENT_MESSAGE_END") continue;
		const content = (event.payload as { content?: unknown[] }).content ?? [];
		for (const block of content) {
			const b = block as { type?: string; id?: string; tool_call_id?: string; arguments?: unknown };
			if (b.type !== "tool_call" && b.type !== "toolCall") continue;
			const id = b.id ?? b.tool_call_id;
			if (id) calls.set(String(id), (b.arguments as Record<string, unknown>) ?? {});
		}
	}
	return calls;
}

function buildPlaceholder(toolName: string, args: Record<string, unknown> | undefined, chars: number): string {
	let argsStr = args
		? Object.entries(args)
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join(", ")
		: "";
	if (argsStr.length > MAX_ARGS_CHARS) argsStr = `${argsStr.slice(0, MAX_ARGS_CHARS)}…`;
	return `[Tool result cleared to save context: ${toolName}(${argsStr}) returned ${chars} chars. Re-run the tool if you need this output again.]`;
}
