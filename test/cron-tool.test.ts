import { describe, expect, it } from "vitest";
import { createCliTestTool } from "./helpers/cli-tool.js";
import type { CronToolOptions } from "../src/core/tools/cron.js";
import type { SchedulerEngine } from "../src/core/scheduler/engine.js";
import type { ScheduledTaskSummary } from "../packages/protocol/index.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** A minimal stand-in for SchedulerEngine that records calls without touching disk. */
function mockEngine(list: ScheduledTaskSummary[] = []): {
	engine: SchedulerEngine;
	createCalls: any[];
} {
	const createCalls: any[] = [];
	const engine = {
		list: () => list,
		get: (id: string) => list.find((t) => t.id === id) ?? null,
		create: (input: any) => {
			createCalls.push(input);
			return {
				ok: true,
				task: {
					id: "st_mock",
					name: input.name,
					scope: "main",
					workspaceId: undefined,
					prompt: input.prompt,
					schedule: input.schedule,
					enabled: true,
					createdAt: 0,
					updatedAt: 0,
					createdBy: "intent",
					runCount: 0,
					nextRunAt: 1000,
				},
			} as any;
		},
		update: (id: string, patch: any) => {
			const t = list.find((x) => x.id === id);
			if (!t) return { ok: false, error: `Task not found: ${id}` } as any;
			const next = { ...t, ...patch, schedule: patch.schedule ?? t.schedule } as ScheduledTaskSummary;
			list[list.indexOf(t)] = next;
			return { ok: true, task: next } as any;
		},
		delete: () => ({ ok: true, id: "st_mock" }) as any,
		runNow: async () => ({ ok: true, taskId: "st_mock", at: Date.now() }) as any,
	} as unknown as SchedulerEngine;
	return { engine, createCalls };
}

describe("_cron built-in cli command", () => {
	it("is recognized as a built-in and shows help (no longer 'command not found')", async () => {
		const tool = createCliTestTool(process.cwd());
		const result = await tool.execute("cron-help", { command: "_cron -h" });
		const output = getTextOutput(result);
		expect(output).toContain("_cron - Manage scheduled/cron jobs");
		expect(output).toContain("Actions:");
		expect(output).toContain("Examples:");
	});

	it("degrades gracefully when no scheduler engine is configured", async () => {
		const tool = createCliTestTool(process.cwd());
		// Not available because the cli tool has no cron option wired.
		await expect(tool.execute("cron-list-no-engine", { command: "_cron list" })).rejects.toThrow(
			/not available.*scheduler|scheduler.*not available/is,
		);
	});

	it("routes _cron list through the cli tool to the engine", async () => {
		const { engine } = mockEngine([
			{
				id: "st_abc",
				name: "self-review",
				scope: "main",
				workspaceId: undefined,
				prompt: "review changes",
				schedule: { mode: "every_n_minutes", everyN: { n: 30 } },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "intent",
				runCount: 0,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		]);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });
		const result = await tool.execute("cron-list", { command: "_cron list" });
		const output = getTextOutput(result);
		expect(output).toContain("st_abc");
		expect(output).toContain("self-review");
		expect(result.details?.command?.name).toBe("_cron");
	});

	it("routes _cron create to the engine with a parsed schedule", async () => {
		const { engine, createCalls } = mockEngine();
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });
		const result = await tool.execute("cron-create", {
			command: '_cron create --schedule 30m --name "self-review" --prompt "review changes"',
		});
		const output = getTextOutput(result);
		expect(output).toContain("Created task");
		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]!.schedule).toMatchObject({ mode: "every_n_minutes" });
		expect(createCalls[0]!.name).toBe("self-review");
		expect(createCalls[0]!.prompt).toBe("review changes");
	});

	it("shows one task in full via _cron show (prompt body + schedule)", async () => {
		const { engine } = mockEngine([
			{
				id: "st_daily",
				name: "morning",
				scope: "main",
				workspaceId: undefined,
				prompt: "summarize yesterday and plan today",
				schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "user",
				runCount: 3,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		]);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });
		const result = await tool.execute("cron-show", { command: "_cron show st_daily" });
		const output = getTextOutput(result);
		// Prompt body is present (the whole point of `show`).
		expect(output).toContain("summarize yesterday and plan today");
		// Full schedule incl. the time point (not just the bare mode name).
		expect(output).toContain("daily 09:00");
		expect(output).toContain("st_daily");
	});

	it("inlines each prompt with _cron list --verbose (compact list does not)", async () => {
		const { engine } = mockEngine([
			{
				id: "st_v",
				name: "v",
				scope: "main",
				workspaceId: undefined,
				prompt: "THE PROMPT BODY",
				schedule: { mode: "every_n_minutes", everyN: { n: 30 } },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "intent",
				runCount: 0,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		]);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });

		// Compact list does NOT show the prompt body.
		const compact = getTextOutput(await tool.execute("cron-list", { command: "_cron list" }));
		expect(compact).not.toContain("THE PROMPT BODY");

		// Verbose list does.
		const verbose = getTextOutput(await tool.execute("cron-list-v", { command: "_cron list --verbose" }));
		expect(verbose).toContain("THE PROMPT BODY");
	});

	it("updates only the schedule via _cron update, leaving the prompt intact", async () => {
		const tasks: ScheduledTaskSummary[] = [
			{
				id: "st_u",
				name: "updatable",
				scope: "main",
				workspaceId: undefined,
				prompt: "original prompt wording",
				schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "user",
				runCount: 0,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		];
		const { engine } = mockEngine(tasks);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });

		// Move the daily fire from 09:00 to 10:10 — the exact scenario from the report.
		const result = await tool.execute("cron-update", {
			command: '_cron update --task st_u --schedule "10 10 * * *"',
		});
		const output = getTextOutput(result);
		expect(output).toContain("Updated task");
		expect(output).toContain("daily 10:10");

		// The prompt was NOT touched (the real-world footgun that motivated this).
		expect(tasks[0]!.prompt).toBe("original prompt wording");
	});

	it("rejects _cron update when nothing is given to change", async () => {
		const { engine } = mockEngine([
			{
				id: "st_n",
				name: "n",
				scope: "main",
				workspaceId: undefined,
				prompt: "p",
				schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "user",
				runCount: 0,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		]);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createCliTestTool(process.cwd(), { cron: cronOptions });
		const output = getTextOutput(await tool.execute("cron-update-noop", { command: "_cron update --task st_n" }));
		expect(output).toContain("nothing to change");
	});
});