import { describe, expect, it, vi } from "vitest";
import { SessionLockManager } from "../../src/core/scheduler/locks.js";
import type { ScheduledTask } from "../../packages/protocol/index.js";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: "t1",
		name: "t1",
		prompt: "p",
		scope: "main",
		schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
		createdBy: "user",
		...overrides,
	};
}

describe("SessionLockManager — basic acquire/release", () => {
	it("grants the lock when the session is free", () => {
		const m = new SessionLockManager();
		const t = makeTask();
		const r = m.acquire(t, "sess1", "skip");
		expect(r.kind).toBe("acquired");
		expect(m.holderOf("sess1")).toBe("t1");
	});

	it("release() clears the lock", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask(), "sess1", "skip");
		m.release("t1", () => {});
		expect(m.holderOf("sess1")).toBeNull();
	});

	it("different sessions are independent", () => {
		const m = new SessionLockManager();
		const r1 = m.acquire(makeTask({ id: "a" }), "sess1", "skip");
		const r2 = m.acquire(makeTask({ id: "b" }), "sess2", "skip");
		expect(r1.kind).toBe("acquired");
		expect(r2.kind).toBe("acquired");
	});
});

describe("SessionLockManager — skip policy", () => {
	it("returns 'skipped' when busy", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "sess1", "skip");
		const r = m.acquire(makeTask({ id: "b" }), "sess1", "skip");
		expect(r.kind).toBe("skipped");
		if (r.kind === "skipped") expect(r.holderTaskId).toBe("a");
	});
});

describe("SessionLockManager — queue policy", () => {
	it("enqueues when busy and fires on release", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "sess1", "queue");
		const r = m.acquire(makeTask({ id: "b" }), "sess1", "queue");
		expect(r.kind).toBe("queued");
		expect(m.inspect("sess1").queueLength).toBe(1);

		const next = vi.fn();
		m.release("a", next);
		expect(next).toHaveBeenCalledTimes(1);
		expect((next.mock.calls[0]![0] as ScheduledTask).id).toBe("b");
		// a was released, b took the lock.
		expect(m.holderOf("sess1")).toBe("b");
		expect(m.inspect("sess1").queueLength).toBe(0);
	});

	it("does not double-enqueue the same task id", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "sess1", "queue");
		m.acquire(makeTask({ id: "b" }), "sess1", "queue");
		m.acquire(makeTask({ id: "b" }), "sess1", "queue");
		expect(m.inspect("sess1").queueLength).toBe(1);
	});

	it("FIFO order across multiple queued tasks", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "sess1", "queue");
		m.acquire(makeTask({ id: "b" }), "sess1", "queue");
		m.acquire(makeTask({ id: "c" }), "sess1", "queue");

		const fired: string[] = [];
		m.release("a", (t) => fired.push(t.id));
		m.release("b", (t) => fired.push(t.id));
		m.release("c", (t) => fired.push(t.id));
		expect(fired).toEqual(["b", "c"]);
	});
});

describe("SessionLockManager — preempt policy", () => {
	it("replaces the current holder and fires onTimeout for the old task", () => {
		const m = new SessionLockManager();
		const onTimeout = vi.fn();
		m.onTimeout = onTimeout;

		m.acquire(makeTask({ id: "a" }), "sess1", "preempt");
		const r = m.acquire(makeTask({ id: "b" }), "sess1", "preempt");
		expect(r.kind).toBe("acquired");
		expect(m.holderOf("sess1")).toBe("b");
		expect(onTimeout).toHaveBeenCalledWith("a", "sess1");
	});

	it("timeout fires onTimeout after the configured delay", () => {
		vi.useFakeTimers();
		try {
			const m = new SessionLockManager();
			const onTimeout = vi.fn();
			m.onTimeout = onTimeout;

			m.acquire(makeTask({ id: "a", timeoutMinutes: 1 }), "sess1", "skip");
			vi.advanceTimersByTime(60_001);
			expect(onTimeout).toHaveBeenCalledWith("a", "sess1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("timeoutMinutes = 0 means no timeout", () => {
		vi.useFakeTimers();
		try {
			const m = new SessionLockManager();
			const onTimeout = vi.fn();
			m.onTimeout = onTimeout;

			m.acquire(makeTask({ id: "a" }), "sess1", "skip");
			vi.advanceTimersByTime(60_000_000);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("SessionLockManager — reassign (lock-key migration)", () => {
	it("moves a holder from one session key to another", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "t1" }), "pending:t1", "skip");
		expect(m.inspect("pending:t1").holder).toBe("t1");
		m.reassign("pending:t1", "ws_real123");
		expect(m.inspect("pending:t1").holder).toBeNull();
		expect(m.inspect("ws_real123").holder).toBe("t1");
		expect(m.holderOf("ws_real123")).toBe("t1");
	});

	it("no-op when old and new session ids are the same", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "t1" }), "pending:t1", "skip");
		m.reassign("pending:t1", "pending:t1");
		expect(m.inspect("pending:t1").holder).toBe("t1");
	});

	it("no-op when the old session id has no holder", () => {
		const m = new SessionLockManager();
		m.reassign("nonexistent", "ws_abc");
		expect(m.inspect("ws_abc").holder).toBeNull();
	});

	it("reassigns queued tasks too", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "pending:a", "queue");
		m.acquire(makeTask({ id: "b" }), "pending:a", "queue");
		m.acquire(makeTask({ id: "c" }), "pending:a", "queue");
		expect(m.inspect("pending:a").queueLength).toBe(2);
		m.reassign("pending:a", "ws_xyz");
		expect(m.inspect("pending:a").queueLength).toBe(0);
		expect(m.inspect("ws_xyz").queueLength).toBe(2);
	});


});

describe("SessionLockManager — dispose", () => {
	it("clears all holders and queues", () => {
		const m = new SessionLockManager();
		m.acquire(makeTask({ id: "a" }), "sess1", "queue");
		m.acquire(makeTask({ id: "b" }), "sess1", "queue");
		m.dispose();
		expect(m.holderOf("sess1")).toBeNull();
		expect(m.inspect("sess1").queueLength).toBe(0);
	});
});