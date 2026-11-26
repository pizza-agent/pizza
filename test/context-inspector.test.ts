import { describe, expect, it } from "vitest";
import {
	selectInspectorTab,
	toInspectorEvents,
} from "../apps/web/src/lib/context-inspector";

const rows = [
	{
		event_id: "e1",
		sequence: 1,
		type: "USER_MESSAGE",
		thread_id: "t1",
		payload: { content: "We need to keep the public API stable." },
	},
	{
		event_id: "e2",
		sequence: 2,
		type: "TOOL_EXECUTION_END",
		thread_id: "t1",
		payload: { result: [{ type: "text", text: "tool output" }], is_error: false },
	},
	{
		event_id: "e3",
		sequence: 3,
		type: "USER_MESSAGE",
		thread_id: "t1",
		payload: { content: "Create a branch named refactor." },
	},
];

describe("context inspector adapter", () => {
	it("preserves real sequence and filters threads", () => {
		const events = toInspectorEvents(rows as never, "t1");
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
		expect(events.map((event) => event.event_id)).toEqual(["e1", "e2", "e3"]);
	});

	it("falls back to chronological position for older servers", () => {
		const events = toInspectorEvents(
			[
				{ event_id: "a", type: "USER_MESSAGE", thread_id: "t1", payload: { content: "first constraint" } },
				{ event_id: "b", type: "USER_MESSAGE", thread_id: "t1", payload: { content: "second constraint" } },
			] as never,
			"t1",
		);
		expect(events.map((event) => event.sequence)).toEqual([1, 2]);
	});

	it("keeps early constraints in pins even when the recent page has only later events", () => {
		const allUsers = toInspectorEvents(rows.filter((row) => row.type === "USER_MESSAGE") as never, "t1");
		const recentPage = toInspectorEvents(rows.slice(1) as never, "t1");
		const pins = selectInspectorTab("pins", recentPage, allUsers, "");
		expect(pins?.evidence.some((item) => item.summary.includes("public API stable"))).toBe(true);
	});

	it("returns no path selection without a path", () => {
		expect(selectInspectorTab("path", toInspectorEvents(rows as never, "t1"), [], "")).toBeNull();
	});
});
