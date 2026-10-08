/**
 * Tool-result masking (observation masking).
 *
 * The cheapest compaction tier: replace large, old tool results with a short
 * placeholder while keeping every user/assistant message and tool call intact.
 * Applied at projection time — events in the store are never modified.
 */

import type { ContentBlock, EventBase } from "../event-store/types.js";
import type { ToolExecutionEndEvent } from "../event-store/events.js";

/** Tool results shorter than this (in chars) are kept verbatim. */
export const DEFAULT_MASK_MIN_CHARS = 500;

const IMAGE_CHARS = 4800;
const MAX_ARGS_CHARS = 200;

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
