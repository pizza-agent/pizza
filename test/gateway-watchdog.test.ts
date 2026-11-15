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

const userMessage = { type: "USER_MESSAGE", payload: { content: "do the task" } };
const turnStart = { type: "AGENT_TURN_START", payload: { message_count: 1 } };
const messageStart = { type: "AGENT_MESSAGE_START", payload: { model: { provider: "test", model_id: "test" } } };
const turnEnd = { type: "AGENT_TURN_END", payload: { tool_calls_count: 0 } };
const taskCompleted = { type: "AGENT_TURN_COMPLETED", payload: { reason: "stop" } };

function messageChunk() {
	return { type: "AGENT_MESSAGE_CHUNK", payload: { chunk: { kind: "text", text: "x" } } };
}

function toolStart(id: string, args: Record<string, unknown> = { path: "a.ts" }) {
	return { type: "TOOL_EXECUTION_START", payload: { tool_call_id: id, tool_name: "read", arguments: args } };
}

function toolEnd(id: string) {
	return {
		type: "TOOL_EXECUTION_END",
		payload: { tool_call_id: id, tool_name: "read", result: [{ type: "text", text: "ok" }], is_error: false, duration_ms: 1 },
	};
}

describe("GatewayWatchdog", () => {
	it("alerts once when a model turn stops producing output", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", messageStart);

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
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", messageStart);
		advance(900);
		watchdog.observe("ws", messageChunk());
		advance(900);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);
	});

	it("alerts when a running tool reports no progress", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ toolIdleMs: 2_000 });
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", toolStart("call_1"));
		advance(1_999);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);
		advance(1);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "tool_idle", turn: 1, toolCallId: "call_1" });
	});

	it("counts repeated calls across LLM/tool rounds in one user task", () => {
		const { watchdog, alerts } = makeWatchdog({ repeatedToolCalls: 2 });
		watchdog.observe("ws", userMessage);

		for (let i = 0; i < 2; i++) {
			watchdog.observe("ws", turnStart);
			watchdog.observe("ws", toolStart(`call_${i}`));
			watchdog.observe("ws", toolEnd(`call_${i}`));
			watchdog.observe("ws", turnEnd);
		}

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "repeated_tool_call", turn: 1, toolName: "read" });
	});

	it("tracks parallel tools independently", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ toolIdleMs: 1_000 });
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", toolStart("first"));
		watchdog.observe("ws", toolStart("second", { path: "b.ts" }));
		watchdog.observe("ws", toolEnd("first"));
		advance(1_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "tool_idle", toolCallId: "second" });
	});

	it("resets the task scope when a new user message arrives", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", messageStart);
		advance(1_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(1);

		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", messageStart);
		advance(1_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(2);
		expect(alerts[1]).toMatchObject({ kind: "stream_idle", turn: 2 });
	});

	it("stops alerting once the user task completes", () => {
		const { watchdog, alerts, advance } = makeWatchdog({ streamIdleMs: 1_000 });
		watchdog.observe("ws", userMessage);
		watchdog.observe("ws", turnStart);
		watchdog.observe("ws", messageStart);
		watchdog.observe("ws", taskCompleted);
		advance(10_000);
		watchdog.sweep();
		expect(alerts).toHaveLength(0);
	});
});
