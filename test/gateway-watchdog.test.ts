import { describe, expect, it } from "vitest";
import { GatewayWatchdog, type WatchdogAlert } from "../packages/gateway/watchdog.js";

function makeWatchdog(options: { streamIdleMs?: number; toolIdleMs?: number; repeatedToolCalls?: number } = {}) {
	let now = 0;
	const alerts: WatchdogAlert[] = [];
	const watchdog = new GatewayWatchdog({
		...options,
		now: () => now,
		onAlert: (alert) => alerts.push(alert),
	});
	return {
		watchdog,
		alerts,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("GatewayWatchdog", () => {
	it("alerts once when a model turn stops producing output", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", { type: "message_start" });

		advance(999);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);

		advance(1);
		watchdog.sweep();
		advance(5_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ workspace: "ws", kind: "stream_idle", turn: 1 });
	});

	it("does not alert while the model is still streaming", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", { type: "message_start" });
		advance(900);
		watchdog.observe("ws", { type: "message_update" });
		advance(900);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);
	});

	it("alerts when a running tool reports no progress", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ toolIdleMs: 2_000 });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", {
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		advance(1_999);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);
		advance(1);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "tool_idle", turn: 1 });
	});

	it("alerts when the same tool call repeats in one turn", () => {
		const { watchdog, alerts } = makeWatchdog({ repeatedToolCalls: 3 });
		watchdog.observe("ws", { type: "turn_start" });
		for (let i = 0; i < 4; i++) {
			watchdog.observe("ws", {
				type: "tool_execution_start",
				toolCallId: `call_${i}`,
				toolName: "read",
				args: { path: "a.ts" },
			});
			watchdog.observe("ws", { type: "tool_execution_end", toolCallId: `call_${i}`, toolName: "read", result: "ok", isError: false });
		}
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "repeated_tool_call", turn: 1 });
	});

	it("treats argument key order as the same repeated call", () => {
		const { watchdog, alerts } = makeWatchdog({ repeatedToolCalls: 2 });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts", limit: 10 } });
		watchdog.observe("ws", { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { limit: 10, path: "a.ts" } });
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.kind).toBe("repeated_tool_call");
	});

	it("resets alert state on a new turn", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", { type: "message_start" });
		advance(1_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);

		watchdog.observe("ws", { type: "turn_end", message: {}, toolResults: [] });
		watchdog.observe("ws", { type: "turn_start" });
		watchdog.observe("ws", { type: "message_start" });
		advance(1_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(2);
		expect(alerts[1]).toMatchObject({ kind: "stream_idle", turn: 2 });
	});
});
