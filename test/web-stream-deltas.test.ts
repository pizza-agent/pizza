import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamDeltaBuffer, type StreamingItem } from "../apps/web/src/lib/stream-deltas.js";

describe("stream delta batching", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	const initial = (): StreamingItem[] => [{ id: "message", text: "", streaming: true }];

	it("coalesces text and thinking from separate events into one frame", () => {
		let items = initial();
		const apply = vi.fn((_ws, update) => { items = update(items); });
		const buffer = new StreamDeltaBuffer<StreamingItem>(apply);
		buffer.queue("a", "message", "text", "hello");
		vi.advanceTimersByTime(10);
		buffer.queue("a", "message", "text", " world");
		buffer.queue("a", "message", "thinking", "reason");
		vi.advanceTimersByTime(22);
		expect(apply).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(items[0]).toMatchObject({ text: "hello world", thinking: "reason" });
	});

	it("flushes before the authoritative end without a trailing duplicate", () => {
		let items = initial();
		const apply = vi.fn((_ws, update) => { items = update(items); });
		const buffer = new StreamDeltaBuffer<StreamingItem>(apply);
		buffer.queue("a", "message", "text", "last chunk");
		buffer.flush("a");
		items = [{ ...items[0], text: "full final answer", streaming: false }];
		vi.runAllTimers();
		expect(items[0].text).toBe("full final answer");
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("preserves the last partial text when a turn aborts without a message end", () => {
		let items = initial();
		const buffer = new StreamDeltaBuffer<StreamingItem>((_ws, update) => { items = update(items); });
		buffer.queue("a", "message", "text", "partial before abort");
		buffer.flush("a");
		items = items.map((item) => ({ ...item, streaming: false }));
		vi.runAllTimers();
		expect(items[0]).toMatchObject({ text: "partial before abort", streaming: false });
	});

	it("makes state updaters replayable and detaches later batches", () => {
		const updates: Array<(items: StreamingItem[]) => StreamingItem[]> = [];
		const buffer = new StreamDeltaBuffer<StreamingItem>((_ws, update) => updates.push(update));
		buffer.queue("a", "message", "text", "one");
		buffer.flush("a");
		buffer.queue("a", "message", "text", "two");
		const before = initial();
		expect(updates[0](before)).toEqual(updates[0](before));
		expect(updates[0](before)[0].text).toBe("one");
		expect(before[0].text).toBe("");
		vi.runAllTimers();
		expect(updates[1](updates[0](before))[0].text).toBe("onetwo");
	});

	it("isolates workspaces even when message IDs match", () => {
		const workspaces = new Map([["a", initial()], ["b", initial()]]);
		const buffer = new StreamDeltaBuffer<StreamingItem>((ws, update) => workspaces.set(ws, update(workspaces.get(ws)!)));
		buffer.queue("a", "message", "text", "A");
		buffer.queue("b", "message", "text", "B");
		buffer.flush("a");
		expect(workspaces.get("b")![0].text).toBe("");
		vi.runAllTimers();
		expect(workspaces.get("a")![0].text).toBe("A");
		expect(workspaces.get("b")![0].text).toBe("B");
	});

	it("discards old sessions and cancels all timers on unmount", () => {
		const apply = vi.fn();
		const buffer = new StreamDeltaBuffer<StreamingItem>(apply);
		buffer.queue("a", "message", "text", "old session");
		buffer.queue("b", "message", "text", "background");
		buffer.discard("a");
		vi.advanceTimersByTime(33);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(apply.mock.calls[0][0]).toBe("b");
		buffer.queue("b", "message", "text", "unmount");
		buffer.clear();
		expect(vi.getTimerCount()).toBe(0);
		vi.runAllTimers();
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("does not apply queued deltas to a bubble already finalized by a reload", () => {
		let items: StreamingItem[] = [{ id: "message", text: "final", streaming: false }];
		const buffer = new StreamDeltaBuffer<StreamingItem>((_ws, update) => { items = update(items); });
		buffer.queue("a", "message", "text", "stale");
		vi.runAllTimers();
		expect(items[0].text).toBe("final");
	});
});
