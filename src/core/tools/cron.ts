/**
 * `_cron` built-in CLI command — manage scheduled/cron jobs.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree/tell/skill), wired up only in RPC/desktop/web mode
 * where a SchedulerEngine is running. TUI mode has no scheduler, so the tool
 * is not registered there.
 *
 * Eight actions:
 *  - list:    show all tasks (id, name, schedule, enabled, next fire). Add --verbose to inline each prompt.
 *  - show:    show one task in full (prompt body + complete schedule incl. time points).
 *  - create:  schedule a recurring prompt (--schedule shorthand or --cron-expr,
 *             plus --prompt; optional --name, --once, --new-session).
 *  - update:  edit one task in place (--task + any of --schedule/--cron-expr/--prompt/--name).
 *             Unspecified fields keep their current value.
 *  - pause:   disable a task (enabled = false).
 *  - resume:  re-enable a task (enabled = true).
 *  - delete:  remove a task.
 *  - run:     fire a task immediately, regardless of its schedule.
 *
 * Dependency injection: the SchedulerEngine is created AFTER the tool
 * (in rpc-mode.ts), so the tool receives a lazy `getEngine()` getter that
 * resolves at execute time. When the engine is not yet ready (or has been
 * disposed), the tool degrades gracefully instead of throwing.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ScheduleSpec, ScheduledTaskSummary } from "../../../packages/protocol/index.js";
import type { SchedulerEngine } from "../scheduler/engine.js";
import { parseScheduleShorthand } from "../scheduler/shorthand.js";
import { mutateTaskAnyScope, readTasksAllScopes } from "../scheduler/store.js";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

/** Supported `_cron` subcommands. */
export const CRON_ACTIONS = ["list", "show", "create", "update", "pause", "resume", "delete", "run"] as const;
export type CronAction = (typeof CRON_ACTIONS)[number];

/**
 * Dependencies injected at tool construction time.
 *
 * `getEngine` is a lazy getter: the SchedulerEngine is instantiated after the
 * tool (in rpc-mode.ts), so we cannot capture it directly. The getter reads a
 * mutable slot that rpc-mode fills in once the engine is ready.
 */
export interface CronToolOptions {
	/** Resolve the engine at execute time. Returns undefined when not running. */
	getEngine: () => SchedulerEngine | undefined;
	/** Scope this sidecar owns ("main" for the persistent agent, else "workspace"). */
	scope: "main" | "workspace";
	/** Resolve the current active session id (for the default pinned target). */
	getActiveSessionId?: () => string | undefined;
}

const cronSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("show"),
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("delete"),
			Type.Literal("run"),
		],
		{
			description:
				"list shows all tasks (add --verbose to inline each prompt); show prints one task in full; " +
				"create schedules a recurring prompt; update edits one in place; " +
				"pause/resume toggle a task on/off; delete removes it; run fires it now.",
		},
	),
	taskId: Type.Optional(
		Type.String({
			description: "Task id (st_xxx). Required for show/update/pause/resume/delete/run.",
		}),
	),
	schedule: Type.Optional(
		Type.String({
			description:
				'Shorthand interval for create/update, e.g. "30m", "every 2h", or a cron expr "0 9 * * 1-5". Required for create unless cronExpr is set.'
		}),
	),
	verbose: Type.Optional(
		Type.Boolean({
			description: "list only: inline the prompt body of each task for quick review. Default: compact one-line rows.",
		}),
	),
	all: Type.Optional(
		Type.Boolean({
			description:
				"list only: show tasks from ALL scopes (main + every workspace), not just the current engine's scope. " +
				"Use this to find tasks that keep firing but are invisible here.",
		}),
	),
	maxRuns: Type.Optional(
		Type.Number({
			description:
				"create/update: auto-disable the task after this many total runs (safety cap for recurring tasks). " +
				"0 clears the cap.",
		}),
	),
	cronExpr: Type.Optional(
		Type.String({ description: "Explicit 5-field cron expression (alternative to schedule)." }),
	),
	prompt: Type.Optional(
		Type.String({
			description:
				"Task instruction dispatched on each fire. Required for create; optional for update (omit to keep current). " +
				"Use --content or a <<EOF heredoc if it contains spaces/newlines.",
		}),
	),
	name: Type.Optional(Type.String({ description: "Optional task name (defaults to a prompt prefix)." })),
	once: Type.Optional(
		Type.Boolean({ description: "Run exactly once then auto-disable (sets endAt to the first fire)." }),
	),
	newSession: Type.Optional(
		Type.Boolean({
			description:
				"Dispatch each fire into a fresh session instead of the current one. Default: pinned to the current session.",
		}),
	),
});

export type CronToolInput = Static<typeof cronSchema>;

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

function errResult(message: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return textResult(message);
}

function fmtTime(ms: number | null | undefined): string {
	if (ms == null) return "—";
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return String(ms);
	}
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Pad a number to 2 digits, e.g. 9 -> "09". */
function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Render a TimeOfDay as 24h "HH:MM". */
function fmtTimeOfDay(t: { hour: number; minute: number }): string {
	return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** Render the schedule of a task as a compact, human-readable one-liner. */
function fmtSchedule(t: ScheduledTaskSummary): string {
	const s = t.schedule;
	switch (s.mode) {
		case "every_n_minutes":
			return `every ${s.everyN?.n ?? "?"} min`;
		case "every_n_hours":
			return `every ${s.everyN?.n ?? "?"} h`;
		case "cron":
			return `cron ${s.cron?.expression ?? "?"}${s.cron?.tz ? ` (${s.cron.tz})` : ""}`;
		case "daily":
			return `daily ${(s.times ?? []).map(fmtTimeOfDay).join(", ") || "?"}`;
		case "weekdays":
			return `weekdays ${(s.times ?? []).map(fmtTimeOfDay).join(", ") || "?"}`;
		case "weekly": {
			const days = (s.weekdays ?? []).slice().sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d] ?? String(d)).join(", ");
			const times = (s.times ?? []).map(fmtTimeOfDay).join(", ");
			return `weekly ${days || "?"} @ ${times || "?"}`;
		}
		case "monthly": {
			const days = (s.daysOfMonth ?? []).slice().sort((a, b) => a - b).join(", ");
			const times = (s.times ?? []).map(fmtTimeOfDay).join(", ");
			return `monthly day ${days || "?"} @ ${times || "?"}`;
		}
		default:
			return s.mode;
	}
}

function formatList(tasks: ScheduledTaskSummary[], verbose = false): string {
	if (tasks.length === 0) return "No scheduled tasks. Use `_cron create` to add one.";
	const rows = tasks.map((t) => {
		const status = t.enabled ? "on " : "off";
		const next = t.nextRunAt == null ? "—" : fmtTime(t.nextRunAt);
		const last = t.lastRunStatus ? ` [last: ${t.lastRunStatus}]` : "";
		const head = `- ${t.id}  "${t.name}"  ${fmtSchedule(t)}  ${status}  next: ${next}${last}`;
		if (!verbose) return head;
		// --verbose: indent the prompt body beneath the one-liner so the user can
		// review what each task actually does without a separate `show` call.
		const body = indent(t.prompt || "(no prompt)");
		return `${head}\n${body}`;
	});
	return `${tasks.length} task(s):\n${rows.join("\n")}`;
}

/** Render tasks gathered from every scope, grouped by scope, for `list --all`. */
function formatAllScopes(): string {
	const entries = readTasksAllScopes();
	if (entries.length === 0) return "No scheduled tasks in any scope.";
	const groups = new Map<string, string[]>();
	for (const { task, scope, workspaceId } of entries) {
		const key = scope === "main" ? "main" : `workspace ${workspaceId}`;
		const status = task.enabled ? "on " : "off";
		const last = task.lastRunStatus ? ` [last: ${task.lastRunStatus}]` : "";
		const runs = ` runs: ${task.runCount ?? 0}${task.maxRuns ? `/${task.maxRuns}` : ""}`;
		const row = `  - ${task.id}  "${task.name}"  ${status} ${runs}${last}`;
		const list = groups.get(key) ?? [];
		list.push(row);
		groups.set(key, list);
	}
	const blocks: string[] = [];
	for (const [key, rows] of groups) {
		blocks.push(`${key}:\n${rows.join("\n")}`);
	}
	return `${entries.length} task(s) across ${groups.size} scope(s):\n${blocks.join("\n")}\n\nTasks outside the current scope can be paused/deleted from here too — pass their id to _cron pause/delete.`;
}

/** Indent every line of `text` by 4 spaces (for nested display). */
function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

/** Render the SessionTarget compactly, or "(default)" when unset. */
function fmtSessionTarget(t: ScheduledTaskSummary): string {
	const target = t.sessionTarget;
	if (!target || target.kind === "current") return "current (default)";
	if (target.kind === "pinned") return `pinned ${target.sessionId ?? "?"}`;
	if (target.kind === "new") return `new session (purpose: ${target.purpose})`;
	return JSON.stringify(target);
}

/** Full multi-line rendering of one task (used by the `show` action). */
function formatDetail(t: ScheduledTaskSummary): string {
	const lines: string[] = [
		`${t.id}  "${t.name}"`,
		`status:     ${t.enabled ? "enabled" : "paused"}${t.lastRunStatus ? `  (last run: ${t.lastRunStatus})` : ""}`,
		`schedule:   ${fmtSchedule(t)}`,
	];
	if (t.sourceText) lines.push(`source:     ${t.sourceText}`);
	lines.push(
		`next fire:  ${fmtTime(t.nextRunAt)}`,
		`last fire:  ${fmtTime(t.lastRunAt)}`,
		`runs:       ${t.runCount ?? 0}${t.maxRuns ? ` (cap: ${t.maxRuns})` : ""}`,
		`target:     ${fmtSessionTarget(t)}`,
		`created:    ${fmtTime(t.createdAt)}  by ${t.createdBy}`,
		`updated:    ${fmtTime(t.updatedAt)}`,
	);
	if (t.timeoutMinutes) lines.push(`timeout:    ${t.timeoutMinutes} min`);
	if (t.concurrencyPolicy) lines.push(`concurrency:${t.concurrencyPolicy}`);
	lines.push("prompt:");
	lines.push(indent(t.prompt || "(no prompt)"));
	return lines.join("\n");
}

export function createCronToolDefinition(
	options: CronToolOptions,
): ToolDefinition<typeof cronSchema, undefined> {
	return defineTool({
		name: "cron",
		label: "cron",
		description:
			"Manage scheduled/cron jobs. list shows all tasks (--verbose inlines each prompt); show prints one task in full; " +
			"create schedules a recurring prompt; update edits one in place (unspecified fields keep their value); " +
			"Schedules fire by dispatching the prompt to the agent in its target session.",
		parameters: cronSchema,
		renderShell: "self",
		async execute(_toolCallId, params) {
			const engine = options.getEngine();
			if (!engine) {
				return errResult(
					"_cron is not available: the scheduler is not running " +
						"(this happens in TUI mode or before the engine is initialized).",
				);
			}

			switch (params.action) {
				case "list": {
					if (params.all) return textResult(formatAllScopes());
					return textResult(formatList(engine.list(), params.verbose === true));
				}

				case "show": {
					if (!params.taskId) return errResult("_cron show: taskId is required.");
					const t = engine.get(params.taskId);
					if (!t) return errResult(`_cron show: task not found: ${params.taskId}`);
					return textResult(formatDetail(t));
				}
				case "create": {
					if (!params.prompt) return errResult("_cron create: --prompt is required.");
					const expr = params.cronExpr ?? params.schedule;
					if (!expr) {
						return errResult(
							"_cron create: --schedule (shorthand) or --cron-expr is required. " +
								'Examples: "30m", "every 2h", "0 9 * * 1-5".',
						);
					}
					const parsed = parseScheduleShorthand(expr);
					if (!parsed.ok) return errResult(`_cron create: ${parsed.error}`);

					const sessionTarget = params.newSession
						? { kind: "new" as const, purpose: params.name ?? "scheduled task" }
						: {
								kind: "pinned" as const,
								sessionId: options.getActiveSessionId?.(),
							};

					const created = engine.create({
						name: params.name ?? "",
						prompt: params.prompt,
						schedule: parsed.spec,
						createdBy: "intent",
						sourceText: expr,
						sessionTarget,
						maxRuns: params.maxRuns && params.maxRuns > 0 ? params.maxRuns : undefined,
					});
					if (!created.ok) return errResult(`_cron create: ${created.error}`);

					// --once: clamp endAt to just past the first fire so the engine
					// disables the task after it runs once.
					if (params.once) {
						const next = created.task.nextRunAt;
						if (next != null) {
							const onceUpdate = engine.update(created.task.id, { endAt: next + 1 });
							if (!onceUpdate.ok) {
								return errResult(
									`Task created as ${created.task.id} but --once could not be applied: ${onceUpdate.error}`,
								);
							}
							return textResult(
								`Created one-shot task ${onceUpdate.task.id} "${onceUpdate.task.name}". ` +
									`Fires once at ${fmtTime(onceUpdate.task.nextRunAt)}, then auto-disables.`,
							);
						}
						return textResult(
							`Created task ${created.task.id} "${created.task.name}", but --once could not be applied ` +
								"(no next fire time). It will run on its normal schedule.",
						);
					}

					return textResult(
						`Created task ${created.task.id} "${created.task.name}" (${fmtSchedule(created.task)}). ` +
							`Next fire: ${fmtTime(created.task.nextRunAt)}.`,
					);
				}

				case "update": {
					if (!params.taskId) return errResult("_cron update: --task is required.");
					const patch: { schedule?: ScheduleSpec; prompt?: string; name?: string; maxRuns?: number | null } = {};
					const expr = params.cronExpr ?? params.schedule;
					if (expr !== undefined) {
						const parsed = parseScheduleShorthand(expr);
						if (!parsed.ok) return errResult(`_cron update: ${parsed.error}`);
						patch.schedule = parsed.spec;
					}
					if (params.prompt !== undefined) patch.prompt = params.prompt;
					if (params.name !== undefined) patch.name = params.name;
					if (params.maxRuns !== undefined) patch.maxRuns = params.maxRuns > 0 ? params.maxRuns : null;
					if (expr === undefined && params.prompt === undefined && params.name === undefined && params.maxRuns === undefined) {
						return errResult("_cron update: nothing to change. Pass --schedule/--cron-expr and/or --prompt/--name/--max-runs.");
					}
					const r = engine.update(params.taskId, patch);
					if (!r.ok) return errResult(`_cron update: ${r.error}`);
					return textResult(
						`Updated task ${r.task.id} "${r.task.name}" (${fmtSchedule(r.task)}).\n` +
							`Next fire: ${fmtTime(r.task.nextRunAt)}.`,
					);
				}
				case "pause":
				case "resume": {
					if (!params.taskId) return errResult(`_cron ${params.action}: taskId is required.`);
					const enabled = params.action === "resume";
					const r = engine.update(params.taskId, { enabled });
					if (!r.ok) {
						// Not in this engine's scope — try every scope on disk. The
						// owning engine re-reads tasks.json before each fire, so the
						// change takes effect at its next tick.
						const x = mutateTaskAnyScope(params.taskId, (t) => ({ ...t, enabled, updatedAt: Date.now() }));
						if (x.found) {
							return textResult(
								`${enabled ? "Resumed" : "Paused"} task ${params.taskId} in ${x.scope === "main" ? "main scope" : `workspace ${x.workspaceId}`} ` +
									`(cross-scope edit; takes effect at that scheduler's next tick).`,
							);
						}
						return errResult(`_cron ${params.action}: ${r.error}`);
					}
					return textResult(
						`${enabled ? "Resumed" : "Paused"} task ${r.task.id} "${r.task.name}". ` +
							`Next fire: ${fmtTime(r.task.nextRunAt)}.`,
					);
				}

				case "delete": {
					if (!params.taskId) return errResult("_cron delete: taskId is required.");
					const r = engine.delete(params.taskId);
					if (!r.ok) {
						const x = mutateTaskAnyScope(params.taskId, () => null);
						if (x.found) {
							return textResult(
								`Deleted task ${params.taskId} from ${x.scope === "main" ? "main scope" : `workspace ${x.workspaceId}`} ` +
									`(cross-scope edit; the owning scheduler drops it at its next tick).`,
							);
						}
						return errResult(`_cron delete: ${r.error}`);
					}
					return textResult(`Deleted task ${r.id}.`);
				}

				case "run": {
					if (!params.taskId) return errResult("_cron run: taskId is required.");
					// runNow is fire-and-forget: it resolves once the task is queued,
					// not when the agent turn completes.
					const r = await engine.runNow(params.taskId);
					if (!r.ok) return errResult(`_cron run: ${r.error}`);
					return textResult(`Fired task ${r.taskId} at ${fmtTime(r.at)} (running in the background).`);
				}

				default:
					return errResult(`_cron: unknown action. Valid actions: ${CRON_ACTIONS.join(", ")}`);
			}
		},
	});
}
