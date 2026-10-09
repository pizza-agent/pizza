import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ChevronRight, Clock, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ScheduledTaskRun, ScheduledTaskSummary } from "@/lib/types";
import {
	deleteScheduledTask,
	getScheduledTaskHistory,
	listScheduledTasks,
	runScheduledTaskNow,
	subscribeEvents,
	updateScheduledTask,
} from "@/lib/transport";
import { MiniSwitch, Spinner } from "@/components/ui";
import { ScheduleForm } from "@/components/ScheduleDialog";
import { describeSchedule, formatNextRun } from "@/components/schedule-utils";
import { resolveScheduleScope } from "@/lib/schedule-scope";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

/** What the popover is currently showing. */
type View = { kind: "list" } | { kind: "edit"; task: ScheduledTaskSummary | null };

/**
 * The composer's clock button. Instead of navigating away, it opens a popover
 * over the input box listing the scheduled tasks of the *current* workspace
 * (each workspace — including the main agent — has its own scheduler store, so
 * this list never mixes tasks across workspaces). From there the user can
 * create a task or edit one inline, in a panel sized for the composer rather
 * than a full-screen modal.
 */
export function ScheduleMenu({
	workspace,
	disabled,
	open,
	onOpenChange,
}: {
	/** Active workspace cwd; decides which scheduler store we read. */
	workspace?: string | null;
	disabled?: boolean;
	/** Controlled by the Composer so the + menu can open this same popover. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation();
	const { scope, workspaceId } = resolveScheduleScope(workspace);
	const wrapRef = useRef<HTMLDivElement>(null);
	const setOpen = onOpenChange;
	const [view, setView] = useState<View>({ kind: "list" });
	const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	// Two-step delete: first click arms the row, second click deletes. Keeps
	// destructive confirmation inside the popover instead of stacking a modal.
	const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setTasks(await listScheduledTasks(scope, workspaceId));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [scope, workspaceId]);

	// Switching workspaces must not leave the previous workspace's tasks on
	// screen: drop the list and close any open editor.
	useEffect(() => {
		setTasks([]);
		setView({ kind: "list" });
		setOpen(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scope, workspaceId]);

	useEffect(() => {
		if (!open) return;
		void refresh();
	}, [open, refresh]);

	// While the popover is open, keep nextRunAt / run counts honest.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		let unsubscribe: (() => void) | null = null;
		(async () => {
			try {
				unsubscribe = await subscribeEvents((event) => {
					const type = (event as { type?: string }).type;
					if (cancelled) return;
					if (type === "SCHEDULED_TASK_FIRED" || type === "SCHEDULED_TASK_COMPLETED") {
						void refresh();
					}
				});
			} catch {
				/* live updates are best-effort; the manual refresh still works */
			}
		})();
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [open, refresh]);

	// Dismiss on outside click / Escape, mirroring the + menu.
	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// Escape backs out of the editor first, then closes the popover.
			if (view.kind === "edit") setView({ kind: "list" });
			else setOpen(false);
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, view.kind]);

	// Every fresh open starts on the list, never on a stale editor.
	useEffect(() => {
		if (!open) return;
		setView({ kind: "list" });
		setArmedDeleteId(null);
	}, [open]);

	const handleToggleEnabled = async (task: ScheduledTaskSummary) => {
		setBusyId(task.id);
		try {
			const updated = await updateScheduledTask(task.id, { enabled: !task.enabled }, scope, workspaceId);
			setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const handleRunNow = async (task: ScheduledTaskSummary) => {
		setBusyId(task.id);
		try {
			await runScheduledTaskNow(task.id, scope, workspaceId);
			setOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const handleDelete = async (task: ScheduledTaskSummary) => {
		setBusyId(task.id);
		try {
			await deleteScheduledTask(task.id, scope, workspaceId);
			setTasks((prev) => prev.filter((x) => x.id !== task.id));
			setArmedDeleteId(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const handleSaved = (task: ScheduledTaskSummary) => {
		setTasks((prev) => {
			const idx = prev.findIndex((x) => x.id === task.id);
			if (idx < 0) return [...prev, task];
			const next = prev.slice();
			next[idx] = task;
			return next;
		});
		setView({ kind: "list" });
	};

	return (
		<div className="relative" ref={wrapRef}>
			<button
				type="button"
				disabled={disabled}
				onClick={() => setOpen(!open)}
				className={cn(
					"flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40",
					open ? "bg-surface text-fg" : "text-muted hover:bg-surface hover:text-fg",
				)}
				title={t("composer.scheduledTask")}
			>
				<Clock className="h-4 w-4" />
			</button>

			{open && (
				<div
					className={cn(
						"absolute bottom-full left-0 mb-2 rounded-xl border border-border bg-surface shadow-xl",
						Z.menu,
						view.kind === "edit" ? "w-[36rem] p-3" : "w-96 p-1",
					)}
				>
					{/* Header: what scope we're looking at + list utilities */}
					<div className="flex items-center gap-2 px-2 py-1.5">
						<Clock className="h-3.5 w-3.5 shrink-0 text-accent" />
						<span className="text-xs font-medium text-fg">
							{view.kind === "edit"
								? view.task
									? t("schedule.editTitle")
									: t("schedule.createTitle")
								: t("composer.scheduledTask")}
						</span>
						<span className="truncate rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
							{scope === "main" ? t("schedule.scopeMain") : t("schedule.scopeWorkspace")}
						</span>
						<span className="ml-auto flex items-center gap-0.5">
							{view.kind === "list" && (
								<button
									type="button"
									onClick={() => void refresh()}
									className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
									title={t("schedule.refresh")}
								>
									<RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
								</button>
							)}
						</span>
					</div>

					{error && (
						<div className="mx-1 mb-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
							{error}
						</div>
					)}

					{view.kind === "edit" ? (
						<ScheduleForm
							key={view.task?.id ?? "new"}
							compact
							scope={scope}
							workspaceId={workspaceId}
							existing={view.task}
							onSaved={handleSaved}
							onCancel={() => setView({ kind: "list" })}
						/>
					) : (
						<>
							<div className="max-h-72 overflow-y-auto">
								{loading && tasks.length === 0 ? (
									<div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted">
										<Spinner />
										{t("schedule.loading")}
									</div>
								) : tasks.length === 0 ? (
									<div className="px-2.5 py-3 text-xs text-muted">{t("schedule.emptyDescription")}</div>
								) : (
									tasks.map((task) => (
										<TaskRow
											key={task.id}
											task={task}
											scope={scope}
											workspaceId={workspaceId}
											busy={busyId === task.id}
											armedDelete={armedDeleteId === task.id}
											onEdit={() => setView({ kind: "edit", task })}
											onToggleEnabled={() => void handleToggleEnabled(task)}
											onRunNow={() => void handleRunNow(task)}
											onDeleteClick={() => {
												if (armedDeleteId === task.id) void handleDelete(task);
												else setArmedDeleteId(task.id);
											}}
										/>
									))
								)}
							</div>

							<div className="my-1 border-t border-border/60" />
							<button
								type="button"
								onClick={() => setView({ kind: "edit", task: null })}
								className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2"
							>
								<Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
								<span className="min-w-0 flex-1">
									<span className="block text-fg">{t("schedule.new")}</span>
									<span className="block text-[10px] text-muted">{t("composer.scheduledTaskHint")}</span>
								</span>
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

function TaskRow({
	task,
	scope,
	workspaceId,
	busy,
	armedDelete,
	onEdit,
	onToggleEnabled,
	onRunNow,
	onDeleteClick,
}: {
	task: ScheduledTaskSummary;
	scope: "main" | "workspace";
	workspaceId?: string;
	busy: boolean;
	armedDelete: boolean;
	onEdit: () => void;
	onToggleEnabled: () => void;
	onRunNow: () => void;
	onDeleteClick: () => void;
}) {
	const { t } = useTranslation();
	// Legacy "current session" tasks can't run until the user re-targets them.
	const needsMigration =
		!task.sessionTarget ||
		task.sessionTarget.kind === "current" ||
		(task.sessionTarget.kind === "pinned" && !task.sessionTarget.sessionId);

	const [expanded, setExpanded] = useState(false);
	const [history, setHistory] = useState<ScheduledTaskRun[] | null>(null);
	const [historyLoading, setHistoryLoading] = useState(false);

	// Lazy-load history when the row is first expanded. Cached afterwards so
	// toggling open/closed doesn't re-fetch every time; the live event
	// subscription in the parent refreshes the task list (and runCount) so the
	// user can hit the refresh button to re-pull if they want fresh rows.
	useEffect(() => {
		if (!expanded || history !== null) return;
		let cancelled = false;
		setHistoryLoading(true);
		(async () => {
			try {
				const runs = await getScheduledTaskHistory(task.id, scope, workspaceId, 20);
				if (!cancelled) setHistory(runs);
			} catch {
				if (!cancelled) setHistory([]);
			} finally {
				if (!cancelled) setHistoryLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [expanded, history, task.id, scope, workspaceId]);

	return (
		<div
			className={cn(
				"rounded-lg transition-colors hover:bg-surface-2",
				busy && "opacity-60",
			)}
		>
			<div className="group flex items-center gap-1 px-2.5 py-2">
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-fg"
					title={t("schedule.history")}
				>
					<ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
				</button>
				<button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left" title={task.prompt}>
					<span className="flex items-center gap-1.5">
						<span className={cn("truncate text-xs", task.enabled ? "text-fg" : "text-muted line-through")}>
							{task.name}
						</span>
						{needsMigration && (
							<span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">!</span>
						)}
						{task.runCount !== undefined && task.runCount > 0 && (
							<span className="shrink-0 text-[10px] text-muted">
								{t("schedule.runCount", { count: task.runCount })}
							</span>
						)}
					</span>
					<span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
						{describeSchedule(task.schedule, t)}
					</span>
					<span className="block truncate text-[10px] text-muted">
						{t("schedule.nextRun")}: {task.enabled ? formatNextRun(task.nextRunAt, t) : t("schedule.disabled")}
					</span>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						onClick={onRunNow}
						disabled={busy || needsMigration}
						className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-surface hover:text-accent disabled:opacity-30 group-hover:opacity-100"
						title={t("schedule.runNow")}
					>
						<Play className="h-3 w-3" />
					</button>
					<button
						type="button"
						onClick={onDeleteClick}
						disabled={busy}
						className={cn(
							"flex h-6 w-6 items-center justify-center rounded transition-colors group-hover:opacity-100",
							armedDelete
								? "bg-danger/15 text-danger opacity-100"
								: "text-muted opacity-0 hover:bg-surface hover:text-danger",
						)}
						title={armedDelete ? t("schedule.confirmDeleteAgain") : t("schedule.delete")}
					>
						<Trash2 className="h-3 w-3" />
					</button>
					<MiniSwitch
						checked={task.enabled}
						disabled={busy}
						onChange={onToggleEnabled}
						aria-label={t("schedule.enabled")}
					/>
				</div>
			</div>

			{expanded && (
				<div className="px-2.5 pb-2 pl-8">
					<div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted">
						<Calendar className="h-3 w-3" />
						{t("schedule.history")}
					</div>
					{historyLoading ? (
						<div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[10px] text-muted">
							<Spinner />
							{t("schedule.loading")}
						</div>
					) : !history || history.length === 0 ? (
						<div className="rounded-md border border-dashed border-border bg-surface-2 px-2 py-1.5 text-[10px] text-muted">
							{t("schedule.historyEmpty")}
						</div>
					) : (
						<ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[10px]">
							{history.map((run, i) => (
								<li key={`${run.at}-${i}`} className="flex items-center gap-1.5 font-mono">
									<span
										className={cn(
											"inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px]",
											run.status === "ok"
												? "bg-success/15 text-success"
												: run.status === "skipped"
													? "bg-warning/15 text-warning"
													: "bg-danger/15 text-danger",
										)}
									>
										{run.status === "ok" ? "✓" : run.status === "skipped" ? "↷" : "✗"}
									</span>
									<span className="text-fg">{new Date(run.at).toLocaleString()}</span>
									{run.reason && <span className="truncate text-muted">— {run.reason}</span>}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
