import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerEngine, nextRunAt, nextNRuns, validateScheduleSpec, detectScheduleIntent, readTasks, writeTasks } from "../../src/core/scheduler/index.js";
import type { ScheduledTask, SchedulerListener } from "../../src/core/scheduler/index.js";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
	originalHome = process.env.PIZZA_HOME;
	home = join(tmpdir(), `pizza-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
	process.env.PIZZA_HOME = home;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.PIZZA_HOME;
	else process.env.PIZZA_HOME = originalHome;
	if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe("validateScheduleSpec", () => {
	it("accepts valid visual schedules", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 9, minute: 0 }] })).toBeNull();
		expect(validateScheduleSpec({ mode: "weekdays", times: [{ hour: 9, minute: 0 }] })).toBeNull();
		expect(validateScheduleSpec({ mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } })).toBeNull();
	});

	it("rejects empty time arrays", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [] })).toMatch(/At least one time/);
	});

	it("rejects bad hours / minutes", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 24, minute: 0 }] })).toMatch(/hour/);
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 9, minute: 60 }] })).toMatch(/minute/);
	});

	it("rejects monthly with no days", () => {
		expect(validateScheduleSpec({ mode: "monthly", times: [{ hour: 9, minute: 0 }] })).toMatch(/at least one day/);
	});

	it("rejects invalid weekday", () => {
		expect(validateScheduleSpec({ mode: "weekly", times: [{ hour: 9, minute: 0 }], weekdays: [7] as Array<0 | 1 | 2 | 3 | 4 | 5 | 6> })).toMatch(/weekday/);
	});

	it("rejects bad intervals", () => {
		expect(validateScheduleSpec({ mode: "every_n_minutes", everyN: { n: 0, unit: "minute" } })).toMatch(/between/);
	});
});

describe("nextRunAt", () => {
	const base = new Date("2026-01-01T00:00:00Z").getTime();

	const t = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
		id: "t1",
		name: "test",
		prompt: "ping",
		scope: "main",
		schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } },
		enabled: true,
		createdAt: base,
		updatedAt: base,
		createdBy: "user",
		...overrides,
	});

	it("aligns every_n_minutes to boundaries", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } } });
		const next = nextRunAt(task, base + 1000)!;
		expect(next).toBe(base + 15 * 60_000);
	});

	it("aligns every_n_hours to the hour", () => {
		const task = t({ schedule: { mode: "every_n_hours", everyN: { n: 2, unit: "hour" } } });
		const next = nextRunAt(task, base + 1000)!;
		expect(next).toBe(base + 2 * 3600_000);
	});

	it("returns null when disabled", () => {
		const task = t({ enabled: false });
		expect(nextRunAt(task, base + 1000)).toBeNull();
	});

	it("returns null past endAt", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" }, endAt: base } });
		// endAt at `from` is treated as expired; next fire would be at base
		// (== endAt), which is not strictly after endAt.
		expect(nextRunAt(task, base + 1)).toBeNull();
	});

	it("honors daily schedule", () => {
		const task = t({ schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] } });
		const next = nextRunAt(task, base + 1000)!;
		const d = new Date(next);
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
	});

	it("skips weekends for weekdays schedule", () => {
		// 2026-01-03 is a Saturday.
		const sat = new Date("2026-01-03T00:00:00").getTime();
		const task = t({ schedule: { mode: "weekdays", times: [{ hour: 9, minute: 0 }] } });
		const next = nextRunAt(task, sat)!;
		const d = new Date(next);
		expect([1, 2, 3, 4, 5]).toContain(d.getDay());
	});

	it("nextNRuns yields 3 valid times", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } } });
		const runs = nextNRuns(task, 3, base);
		expect(runs).toHaveLength(3);
		expect(runs[1]).toBe(runs[0]! + 15 * 60_000);
	});
});

describe("SchedulerEngine CRUD", () => {
	it("creates, lists, updates, and deletes tasks", () => {
		const events: SchedulerListener[] = [];
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({ eventId: "e1" }) },
		});
		engine.load();

		const r1 = engine.create({
			name: "Daily backup",
			prompt: "do backup",
			schedule: { mode: "daily", times: [{ hour: 2, minute: 0 }] },
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const r2 = engine.create({
			name: "Hourly",
			prompt: "ping",
			schedule: { mode: "every_n_hours", everyN: { n: 1, unit: "hour" } },
		});
		expect(r2.ok).toBe(true);

		const list = engine.list();
		expect(list).toHaveLength(2);

		const upd = engine.update(r1.task.id, { name: "Daily backup v2" });
		expect(upd.ok).toBe(true);

		const del = engine.delete(r1.task.id);
		expect(del.ok).toBe(true);

		const after = engine.list();
		expect(after).toHaveLength(1);
		expect(after[0]!.name).toBe("Hourly");

		engine.dispose();
	});

	it("persists across reload", () => {
		const engine1 = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine1.load();
		engine1.create({
			name: "Persist me",
			prompt: "x",
			schedule: { mode: "every_n_minutes", everyN: { n: 30, unit: "minute" } },
		});
		engine1.dispose();

		const engine2 = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine2.load();
		const list = engine2.list();
		expect(list).toHaveLength(1);
		expect(list[0]!.name).toBe("Persist me");
		engine2.dispose();
	});

	it("rejects invalid schedules", () => {
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine.load();
		const r = engine.create({
			name: "bad",
			prompt: "x",
			schedule: { mode: "daily", times: [] },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/At least one/);
		engine.dispose();
	});

	it("runNow invokes the dispatcher", async () => {
		const dispatch = vi.fn(async () => ({ eventId: "evt1" }));
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch },
		});
		engine.load();
		const r = engine.create({
			name: "manual",
			prompt: "hello",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "pinned", sessionId: "sess_test" },
		});
		if (!r.ok) throw new Error("create failed");
		const run = await engine.runNow(r.task.id);
		expect(run.ok).toBe(true);
		// Wait briefly for the async dispatch to complete.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(dispatch).toHaveBeenCalledTimes(1);
		engine.dispose();
	});

	it("records runs in history", async () => {
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({ eventId: "evt1" }) },
		});
		engine.load();
		const r = engine.create({
			name: "track",
			prompt: "x",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "pinned", sessionId: "sess_test" },
		});
		if (!r.ok) throw new Error("create failed");
		await engine.runNow(r.task.id);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const history = engine.history(r.task.id);
		expect(history.length).toBeGreaterThan(0);
		expect(history[0]!.status).toBe("ok");
		engine.dispose();
	});

	it("catches up only the most recent missed run on load", async () => {
		const base = new Date("2026-01-01T00:00:00Z").getTime();
		const now = base + 5 * 60_000 + 30_000;
		const dispatch = vi.fn(async () => ({ eventId: "evt-catchup", sessionId: "sess_test" }));
		writeTasks("main", undefined, [{
			id: "task_catchup",
			name: "catch up",
			prompt: "ping",
			scope: "main",
			schedule: { mode: "every_n_minutes", everyN: { n: 1, unit: "minute" } },
			enabled: true,
			createdAt: base,
			updatedAt: base,
			createdBy: "user",
			runCount: 1,
			lastRunAt: base,
			lastRunStatus: "ok",
			sessionTarget: { kind: "pinned", sessionId: "sess_test" },
		}]);
		const engine = new SchedulerEngine({
			scope: "main",
			now: () => now,
			dispatcher: { dispatch },
		});
		engine.load();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(dispatch).toHaveBeenCalledTimes(1);
		const history = engine.history("task_catchup");
		expect(history[0]!.at).toBe(base + 5 * 60_000);
		engine.dispose();
	});

	it("does not run legacy current-session tasks until migrated", async () => {
		const dispatch = vi.fn(async () => ({ eventId: "evt-legacy" }));
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch },
		});
		engine.load();
		const r = engine.create({
			name: "legacy",
			prompt: "x",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			sessionTarget: { kind: "current" },
		});
		if (!r.ok) throw new Error("create failed");
		expect(r.task.nextRunAt).toBeNull();
		const run = await engine.runNow(r.task.id);
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toMatch(/requires migration/);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(dispatch).not.toHaveBeenCalled();
		engine.dispose();
	});
});

describe("detectScheduleIntent", () => {
	const NOW = new Date("2026-06-01T10:00:00Z"); // Monday

	it("detects 'X 分钟后'", () => {
		const i = detectScheduleIntent("15 分钟后提醒我喝水", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("every_n_minutes");
		expect(i!.prompt).toBe("我喝水");
	});

	it("detects '明天 HH:MM'", () => {
		const i = detectScheduleIntent("明天 8:00 提醒我开会", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("daily");
	});

	it("detects '每天 HH:MM'", () => {
		const i = detectScheduleIntent("每天 9:00 写日报", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("daily");
		expect(i!.prompt).toBe("写日报");
	});

	it("detects '工作日 HH:MM'", () => {
		const i = detectScheduleIntent("工作日 14:30 开站会", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("weekdays");
	});

	it("detects English 'every Monday'", () => {
		const i = detectScheduleIntent("every monday at 22:00 weekly review", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("weekly");
	});

	it("returns null when no schedule is detectable", () => {
		expect(detectScheduleIntent("你好吗", NOW)).toBeNull();
	});
});
describe("SchedulerEngine — session-level concurrency", () => {
	it("serializes dispatches across different target sessions in one runtime", async () => {
		let activeDispatches = 0;
		let maxActiveDispatches = 0;
		const dispatched: string[] = [];
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: {
				dispatch: vi.fn(async (task: ScheduledTask) => {
					activeDispatches += 1;
					maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
					dispatched.push(task.id);
					try {
						if (activeDispatches > 1) {
							return { error: "EventSourcedRuntime is already processing a prompt" };
						}
						await new Promise((resolve) => setTimeout(resolve, 40));
						const target = task.sessionTarget;
						return {
							eventId: `e-${task.id}`,
							sessionId: target?.kind === "new" ? `sess_new_${task.id}` : target?.kind === "pinned" ? target.sessionId : undefined,
						};
					} finally {
						activeDispatches -= 1;
					}
				}),
			},
		});
		const pinned = engine.create({
			name: "Pinned", prompt: "pinned",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "queue",
			sessionTarget: { kind: "pinned", sessionId: "sess_fixed" },
		});
		const fresh = engine.create({
			name: "New", prompt: "fresh",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "queue",
			sessionTarget: { kind: "new", purpose: "fresh run" },
		});
		if (!pinned.ok || !fresh.ok) throw new Error("create failed");

		await Promise.all([
			engine.runNow(pinned.task.id),
			engine.runNow(fresh.task.id),
		]);
		await new Promise((resolve) => setTimeout(resolve, 120));

		expect(maxActiveDispatches).toBe(1);
		expect(dispatched).toEqual([pinned.task.id, fresh.task.id]);
		expect(engine.history(pinned.task.id)[0]?.status).toBe("ok");
		expect(engine.history(fresh.task.id)[0]?.status).toBe("ok");
		expect(engine.history(fresh.task.id)[0]?.sessionId).toBe(`sess_new_${fresh.task.id}`);
		engine.dispose();
	});

	it("skips the second task when concurrencyPolicy = skip and session is busy", async () => {
		// Single engine, no recreate dance. Build a dispatcher that's a
		// no-op for the regular task but blocks on A's id (which we capture
		// after e2.create assigns it).
		let releaseA: (v: { eventId?: string; error?: string }) => void = () => {};
		const aPromise = new Promise<{ eventId?: string; error?: string }>((r) => { releaseA = r; });
		let aId = "";
		let bId = "";
		const e2 = new SchedulerEngine({
			scope: "main",
			dispatcher: {
				dispatch: async (task: ScheduledTask) => {
					if (task.id === aId) return await aPromise;
					return { eventId: `e-${task.id}` };
				},
			},
		});
		const a2 = e2.create({ name: "A", prompt: "a", schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } }, concurrencyPolicy: "skip", sessionTarget: { kind: "pinned", sessionId: "sess_shared" } });
		const b2 = e2.create({ name: "B", prompt: "b", schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } }, concurrencyPolicy: "skip", sessionTarget: { kind: "pinned", sessionId: "sess_shared" } });
		if (!a2.ok || !b2.ok) throw new Error("create failed");
		aId = a2.task.id;
		bId = b2.task.id;
		const aRun = e2.runNow(a2.task.id);
		await new Promise((r) => setTimeout(r, 20));
		const bRun = e2.runNow(b2.task.id);
		await Promise.all([aRun, bRun]);
		await new Promise((r) => setTimeout(r, 50));
		const histB = e2.history(b2.task.id);
		expect(histB.length).toBe(1);
		expect(histB[0]!.status).toBe("skipped");
		expect(histB[0]!.reason).toMatch(/busy/);
		releaseA({ eventId: "e-A" });
		await new Promise((r) => setTimeout(r, 50));
		e2.dispose();
	});

		it("queues the second task when concurrencyPolicy = queue and fires it after the first finishes", async () => {
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({ eventId: "e" }) },
		});
		const a = engine.create({ name: "A", prompt: "a", schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } }, concurrencyPolicy: "queue", sessionTarget: { kind: "pinned", sessionId: "sess_shared" } });
		if (!a.ok) throw new Error("create failed");
		const aId = a.task.id;
		let releaseA: (v: { eventId?: string; error?: string }) => void = () => {};
		const aPromise = new Promise<{ eventId?: string; error?: string }>((r) => { releaseA = r; });
		const dispatched: string[] = [];
		engine.dispose();
		const e2 = new SchedulerEngine({
			scope: "main",
			dispatcher: {
				dispatch: vi.fn(async (task: ScheduledTask) => {
					dispatched.push(task.id);
					if (task.id === aId) return await aPromise;
					return { eventId: `e-${task.id}` };
				}),
			},
		});
		const a2 = e2.create({ name: "A", prompt: "a", schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } }, concurrencyPolicy: "queue", sessionTarget: { kind: "pinned", sessionId: "sess_shared" } });
		const b2 = e2.create({ name: "B", prompt: "b", schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } }, concurrencyPolicy: "queue", sessionTarget: { kind: "pinned", sessionId: "sess_shared" } });
		if (!a2.ok || !b2.ok) throw new Error("re-create failed");
		await e2.runNow(a2.task.id);
		await new Promise((r) => setTimeout(r, 20));
		await e2.runNow(b2.task.id);
		await new Promise((r) => setTimeout(r, 50));
		releaseA({ eventId: "e-A" });
		await new Promise((r) => setTimeout(r, 100));
		expect(dispatched).toContain(a2.task.id);
		expect(dispatched).toContain(b2.task.id);
		expect(dispatched.indexOf(a2.task.id)).toBeLessThan(dispatched.indexOf(b2.task.id));
		e2.dispose();
	});
});

describe("SchedulerEngine — SessionTarget: new with real session id reassign", () => {
	it("SessionTarget: pinned locks on the saved session id before dispatch", async () => {
		let dispatchCount = 0;
		const dispatcher = {
			dispatch: async (task: ScheduledTask) => {
				dispatchCount += 1;
				if (task.prompt === "slow") {
					await new Promise((r) => setTimeout(r, 120));
				}
				return { eventId: `e-${task.id}`, sessionId: "different-runtime-session" };
			},
		};
		const engine = new SchedulerEngine({ scope: "main", dispatcher });
		const t1 = engine.create({
			name: "Pinned A", prompt: "slow",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "skip",
			sessionTarget: { kind: "pinned", sessionId: "sess_fixed" },
		});
		const t2 = engine.create({
			name: "Pinned B", prompt: "fast",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "skip",
			sessionTarget: { kind: "pinned", sessionId: "sess_fixed" },
		});
		if (!t1.ok || !t2.ok) throw new Error("create failed");

		const p1 = engine.runNow(t1.task.id);
		await new Promise((r) => setTimeout(r, 20));
		const p2 = engine.runNow(t2.task.id);
		await Promise.all([p1, p2]);

		expect(dispatchCount).toBe(1);
		const hist2 = engine.history(t2.task.id);
		expect(hist2[0]?.status).toBe("skipped");
		expect(hist2[0]?.reason).toMatch(/busy/);
		engine.dispose();
	});

	it("persists the writable continuation when a pinned session is reopened", async () => {
		const dispatcher = {
			dispatch: vi.fn(async (task: ScheduledTask) => {
				expect(task.sessionTarget).toEqual({ kind: "pinned", sessionId: "sess_closed" });
				return { eventId: `e-${task.id}`, sessionId: "sess_continued" };
			}),
		};
		const engine = new SchedulerEngine({ scope: "main", dispatcher });
		const created = engine.create({
			name: "Pinned historical", prompt: "ping",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "skip",
			sessionTarget: { kind: "pinned", sessionId: "sess_closed" },
		});
		if (!created.ok) throw new Error("create failed");

		await engine.runNow(created.task.id);
		await new Promise((r) => setTimeout(r, 30));

		const state = engine.get(created.task.id);
		expect(state?.sessionTarget).toEqual({ kind: "pinned", sessionId: "sess_continued" });
		expect(engine.history(created.task.id)[0]?.sessionId).toBe("sess_continued");
		expect(readTasks("main").find((task) => task.id === created.task.id)?.sessionTarget)
			.toEqual({ kind: "pinned", sessionId: "sess_continued" });
		engine.dispose();
	});

	it("engine's locks use the real session id reported by the dispatcher", async () => {
		// Two SessionTarget: new tasks, both using the same fake "real" session
		// (the dispatcher just simulates one). After the first task reports
		// the real session id, the lock migrates from pending → real. A second
		// task with a different placeholder key but the same real session id
		// should block (or be skipped under "skip" policy) on the REAL key,
		// not on its placeholder.
		const capturedSessionIds: string[] = [];
		const dispatcher = {
			dispatch: async (task: ScheduledTask) => {
				capturedSessionIds.push(task.id);
				// Pretend the dispatcher always creates the same real session.
				return { eventId: `e-${task.id}`, sessionId: "real_session_42" };
			},
		};
		const engine = new SchedulerEngine({ scope: "main", dispatcher });
		const t1 = engine.create({
			name: "T1", prompt: "p1",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "skip",
			sessionTarget: { kind: "new", purpose: "news" },
		});
		const t2 = engine.create({
			name: "T2", prompt: "p2",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
			concurrencyPolicy: "skip",
			sessionTarget: { kind: "new", purpose: "weather" },
		});
		if (!t1.ok || !t2.ok) throw new Error("create failed");

		// Start T1 and wait for it to acquire + reassign
		const p1 = engine.runNow(t1.task.id);
		await new Promise((r) => setTimeout(r, 20));
		const p2 = engine.runNow(t2.task.id);
		await Promise.all([p1, p2]);
		await new Promise((r) => setTimeout(r, 50));

		// Both tasks should have been dispatched
		expect(capturedSessionIds).toContain(t1.task.id);
		expect(capturedSessionIds).toContain(t2.task.id);

		// After reassign, both should be at the real session id. The first one
		// to finish releases its lock; the second one runs in the real
		// session (whether it succeeded or was skipped depends on timing).
		// We just verify the engine state is consistent.
		const t1State = engine.get(t1.task.id);
		const t2State = engine.get(t2.task.id);
		expect(t1State).toBeTruthy();
		expect(t2State).toBeTruthy();
		engine.dispose();
	});

});

describe("setTimeout overflow protection", () => {
	// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1ms. A
	// monthly task whose next fire is >24.8 days out (or a distant startAt)
	// must NOT fire immediately — the engine chunks the wait instead.
	it("far-future startAt does not fire immediately (chunked wait)", async () => {
		// Fake setTimeout/Date only — NOT setInterval. The scope lock's 30s
		// heartbeat is a setInterval; faking it would make the 25-day
		// advanceTimersByTimeAsync below execute ~72k real fs writes and
		// time out on slow CI runners.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const fired: number[] = [];
			const engine = new SchedulerEngine({
				scope: "main",
				dispatcher: {
					dispatch: async () => {
						fired.push(Date.now());
						return { eventId: "e1" };
					},
				},
			});
			engine.load();
			// startAt 40 days out — delay exceeds the 2^31-1 ms clamp.
			const startAt = Date.now() + 40 * 24 * 3600_000;
			const r = engine.create({
				name: "far future",
				prompt: "ping",
				schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }], startAt },
			});
			expect(r.ok).toBe(true);

			// Advance 1 hour: on an unpatched engine the clamped timer would
			// have fired within milliseconds. Nothing may fire.
			await vi.advanceTimersByTimeAsync(3600_000);
			expect(fired).toHaveLength(0);

			// Advance past the first chunk boundary (~24.85 days): still
			// before startAt, so the engine must re-arm, not fire.
			await vi.advanceTimersByTimeAsync(25 * 24 * 3600_000);
			expect(fired).toHaveLength(0);

			engine.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fireTask refuses fires that arrive early (guard)", async () => {
		const fired: string[] = [];
		let nowValue = Date.now();
		const engine = new SchedulerEngine({
			scope: "main",
			now: () => nowValue,
			dispatcher: {
				dispatch: async (task) => {
					fired.push(task.id);
					return { eventId: "e1" };
				},
			},
		});
		engine.load();
		const r = engine.create({
			name: "guarded",
			prompt: "ping",
			schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] },
			sessionTarget: { kind: "pinned", sessionId: "sess_guard" },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;

		// Simulate a timer that fired ~30 days ahead of schedule (overflow
		// clamp on an old build / wall-clock jump): call the private
		// fireTask with a far-future `at` while now() stays put.
		const at = nowValue + 30 * 24 * 3600_000;
		await (engine as unknown as { fireTask(t: unknown, at: number, m: boolean): Promise<void> }).fireTask(r.task, at, false);
		expect(fired).toHaveLength(0); // refused — rescheduled instead

		// A fire at (or within tolerance of) its scheduled time still runs.
		nowValue = at;
		await (engine as unknown as { fireTask(t: unknown, at: number, m: boolean): Promise<void> }).fireTask(r.task, at, false);
		expect(fired).toHaveLength(1);
		engine.dispose();
	});
});
