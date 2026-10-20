/**
 * Crash recovery — compensate dangling turn state left by a previous process.
 *
 * All turn-level bookkeeping (TurnTrackers, pending approvals, retry timers)
 * lives in reactor memory. When a process dies mid-turn the log is left with:
 *
 *   - AGENT_MESSAGE_END events whose tool_calls never received a
 *     TOOL_EXECUTION_END (tool was executing, or approval was pending);
 *   - possibly a TOOL_EXECUTION_START with no matching END;
 *   - no AGENT_TURN_COMPLETED for the interrupted turn.
 *
 * The first case is fatal for the next LLM call: projections build an
 * assistant message containing tool_use blocks with no tool_result reply,
 * which most provider APIs reject — the session can never continue.
 *
 * recoverDanglingTurnState() scans the log once at startup and appends
 * compensating events:
 *
 *   - TOOL_EXECUTION_START (if missing) + TOOL_EXECUTION_END (is_error) for
 *     every unresolved tool call, so START/END pairing holds for
 *     projections and the timeline UI;
 *   - AGENT_TURN_COMPLETED (reason "aborted") per interrupted thread when
 *     the dangling assistant message is not already followed by one.
 *
 * MUST only be called when this process is the sole driver of the workspace
 * (workspace lock held): with a concurrent live process, an in-flight tool
 * is indistinguishable from a crashed one, and compensating it here would
 * produce a duplicate TOOL_EXECUTION_END when the live process finishes.
 */

import type { EventStore } from "../event-store/store.js";
import type { EventBase } from "../event-store/types.js";

export interface CrashRecoveryResult {
	/** Compensated tool calls (one TOOL_EXECUTION_END each). */
	compensated_tool_call_ids: string[];
	/** Threads that received a compensating AGENT_TURN_COMPLETED. */
	completed_thread_ids: string[];
}

interface ToolCallBlock {
	id?: string;
	tool_call_id?: string;
	name?: string;
	tool_name?: string;
	arguments?: Record<string, unknown>;
}

/** Extract tool_call blocks from an AGENT_MESSAGE_END payload. */
function toolCallsOf(event: EventBase): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	const content = (event.payload as { content?: unknown[] }).content;
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const block of content) {
		const b = block as { type?: string } & ToolCallBlock;
		if (b.type !== "tool_call" && b.type !== "toolCall") continue;
		const id = String(b.id ?? b.tool_call_id ?? "");
		if (!id) continue;
		calls.push({ id, name: String(b.name ?? b.tool_name ?? ""), arguments: b.arguments ?? {} });
	}
	return calls;
}

/**
 * Fast-path capabilities of the SQLite store: payload projection without
 * materializing full events (TOOL_EXECUTION_END payloads embed entire tool
 * results — often 100MB+ on a long-lived workspace).
 */
interface MessageToolCallRow {
	sequence: number;
	event_id: string;
	thread_id?: string;
	caused_by?: string;
	call: { id: string; name: string; arguments: Record<string, unknown> };
}

interface PayloadProjectingStore extends EventStore {
	toolCallIds(types: EventBase["type"][]): Set<string>;
	messageToolCallRows(): MessageToolCallRow[];
}

function isPayloadProjectingStore(store: EventStore): store is PayloadProjectingStore {
	const s = store as Partial<PayloadProjectingStore>;
	return typeof s.toolCallIds === "function" && typeof s.messageToolCallRows === "function";
}

/**
 * Scan the log for tool calls interrupted by a crash and append compensating
 * events. Idempotent: a second run finds no unresolved calls and does nothing.
 */
export function recoverDanglingTurnState(store: EventStore): CrashRecoveryResult {
	const result: CrashRecoveryResult = { compensated_tool_call_ids: [], completed_thread_ids: [] };

	// Only assistant messages containing tool calls matter; the SQLite fast
	// path returns flattened (message, call) rows — generic stores fall back
	// to parsing AGENT_MESSAGE_END payloads and flattening here.
	const callRows: MessageToolCallRow[] = isPayloadProjectingStore(store)
		? store.messageToolCallRows()
		: store
				.query({ types: ["AGENT_MESSAGE_END"] })
				.flatMap((messageEnd) =>
					toolCallsOf(messageEnd).map((call) => ({
						sequence: messageEnd.sequence,
						event_id: messageEnd.event_id,
						thread_id: messageEnd.thread_id,
						caused_by: messageEnd.caused_by,
						call,
					})),
				);
	if (callRows.length === 0) return result;

	// Resolved tool calls: any TOOL_EXECUTION_END (real or compensated).
	const resolvedIds = isPayloadProjectingStore(store)
		? store.toolCallIds(["TOOL_EXECUTION_END"])
		: new Set(
				store
					.query({ types: ["TOOL_EXECUTION_END"] })
					.map((end) => (end.payload as { tool_call_id?: string }).tool_call_id)
					.filter((id): id is string => typeof id === "string"),
			);
	// Started tool calls: those already have a START; do not emit a second one.
	const startedIds = isPayloadProjectingStore(store)
		? store.toolCallIds(["TOOL_EXECUTION_START"])
		: new Set(
				store
					.query({ types: ["TOOL_EXECUTION_START"] })
					.map((start) => (start.payload as { tool_call_id?: string }).tool_call_id)
					.filter((id): id is string => typeof id === "string"),
			);

	// Threads whose dangling message needs a compensating turn completion:
	// thread_id → sequence of the latest dangling AGENT_MESSAGE_END.
	const interruptedThreads = new Map<string | undefined, number>();

	for (const row of callRows) {
		const call = row.call;
		if (resolvedIds.has(call.id)) continue;

		if (!startedIds.has(call.id)) {
			store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_START",
				payload: { tool_call_id: call.id, tool_name: call.name, arguments: call.arguments },
				caused_by: row.event_id,
				thread_id: row.thread_id,
			});
		}
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: call.id,
				tool_name: call.name,
				result: [{ type: "text", text: "Tool execution was interrupted: the process exited before the tool completed." }],
				is_error: true,
				duration_ms: 0,
			},
			caused_by: row.event_id,
			thread_id: row.thread_id,
		});
		result.compensated_tool_call_ids.push(call.id);
		resolvedIds.add(call.id);

		const prev = interruptedThreads.get(row.thread_id) ?? -1;
		if (row.sequence > prev) interruptedThreads.set(row.thread_id, row.sequence);
	}

	// Close interrupted turns so settled-state queries (last USER_MESSAGE vs last
	// AGENT_TURN_COMPLETED) do not consider the crashed turn still in flight.
	for (const [threadId, danglingSeq] of interruptedThreads) {
		const laterCompletion = store
			.query({ types: ["AGENT_TURN_COMPLETED"], thread_id: threadId, after_sequence: danglingSeq, limit: 1 });
		if (laterCompletion.length > 0) continue;
		const completed = store.append({
			actor_id: "runtime",
			type: "AGENT_TURN_COMPLETED",
			payload: { reason: "aborted", error_message: "Turn interrupted: process exited mid-turn (recovered on restart)." },
			thread_id: threadId,
		});
		result.completed_thread_ids.push(threadId ?? completed.thread_id ?? "");
	}

	return result;
}