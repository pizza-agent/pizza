import type { RpcForensicEvent } from "@/lib/types";
import {
	selectGoalPins,
	selectPathContext,
	selectRecentContext,
	type ContextSelection,
} from "../../../../src/core/context/goal-pins";

export type { ContextSelection };

export type InspectorTab = "pins" | "recent" | "path";

export interface InspectorEvent {
	event_id: string;
	type: string;
	sequence: number;
	thread_id?: string;
	payload: unknown;
}

/**
 * Adapt RPC forensic events to the deterministic core selectors.
 *
 * `getEvents` returns chronological events; newer servers also include the
 * real workspace sequence. Fall back to array position for older servers,
 * but callers must fetch all USER_MESSAGE events for the pins tab (not just the
 * recent event page), otherwise early constraints would be invisible.
 */
export function toInspectorEvents(rows: RpcForensicEvent[], threadId?: string): InspectorEvent[] {
	return rows
		.filter((row) => !threadId || row.thread_id === threadId)
		.map((row, index) => ({
			event_id: row.event_id,
			type: row.type,
			sequence: row.sequence ?? index + 1,
			thread_id: row.thread_id,
			payload: row.payload,
		}));
}

export function selectInspectorTab(
	tab: InspectorTab,
	recent: InspectorEvent[],
	pins: InspectorEvent[],
	path: string,
): ContextSelection | null {
	const events = (tab === "pins" ? pins : recent) as never;
	if (tab === "pins") return selectGoalPins(events, { tokenBudget: 1200 });
	if (tab === "recent") return selectRecentContext(events, { tokenBudget: 2000 });
	return path.trim() ? selectPathContext(events, path.trim(), { tokenBudget: 2000 }) : null;
}
