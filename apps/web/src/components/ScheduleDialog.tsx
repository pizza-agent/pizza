import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConcurrencyPolicy, ScheduleSpec, ScheduledTaskSummary, SessionTarget, Weekday } from "@/lib/types";
import { Button, ErrorBanner, Field, Modal, Select, Spinner } from "@/components/ui";
import { ScheduleModePicker } from "@/components/ScheduleModePicker";
import { TimePointChips } from "@/components/TimePointChips";
import { SchedulePreview } from "@/components/SchedulePreview";
import { createScheduledTask, getSchedulerPolicy, getSessionState, updateScheduledTask } from "@/lib/transport";
import { cn } from "@/lib/utils";

type Scope = "main" | "workspace";

interface ScheduleFormProps {
	scope: Scope;
	workspaceId?: string;
	/** When editing, the existing task. When creating, undefined. */
	existing?: ScheduledTaskSummary | null;
	onSaved: (task: ScheduledTaskSummary) => void;
	onCancel: () => void;
	/**
	 * Compact layout for the inline composer popover: tighter spacing and a
	 * shorter scroll area so the panel stays anchored above the input box
	 * instead of taking over the whole screen like the page-level modal.
	 */
	compact?: boolean;
}

interface ScheduleDialogProps extends Omit<ScheduleFormProps, "onCancel" | "compact"> {
	open: boolean;
	onClose: () => void;
}

/** Build an empty visual schedule for "create" mode. */
function blankSpec(): ScheduleSpec {
	return {
		mode: "daily",
		times: [{ hour: 9, minute: 0 }],
	};
}

function defaultSessionTarget(sessionId?: string): SessionTarget {
	return sessionId ? { kind: "pinned", sessionId } : { kind: "pinned" };
}

function editableSessionTarget(target: SessionTarget | undefined, sessionId?: string): SessionTarget {
	if (!target || target.kind === "current") return defaultSessionTarget(sessionId);
	return target;
}

/**
 * Modal shell around {@link ScheduleForm}, used by the full Schedules page.
 * The composer popover renders `ScheduleForm` directly instead, so creating /
 * editing a task from the input box never blocks the whole window.
 */
export function ScheduleDialog(props: ScheduleDialogProps) {
	const { t } = useTranslation();
	const { open, onClose, ...rest } = props;
	if (!open) return null;
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={rest.existing ? t("schedule.editTitle") : t("schedule.createTitle")}
		>
			{/* Remount on target change so all field state resets cleanly. */}
			<ScheduleForm key={rest.existing?.id ?? "new"} {...rest} onCancel={onClose} />
		</Modal>
	);
}

export function ScheduleForm(props: ScheduleFormProps) {
	const { t } = useTranslation();
	const { scope, workspaceId, existing, onSaved, onCancel, compact } = props;
	const isEdit = !!existing;

	const [name, setName] = useState(existing?.name ?? "");
	const [prompt, setPrompt] = useState(existing?.prompt ?? "");
	const [spec, setSpec] = useState<ScheduleSpec>(existing?.schedule ?? blankSpec());
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const weekdayShortRaw = t("schedule.weekdayShort", { returnObjects: true });
	const weekdayLongRaw = t("schedule.weekdayLong", { returnObjects: true });
	const weekdayShort: string[] = Array.isArray(weekdayShortRaw) ? weekdayShortRaw : [];
	const weekdayLong: string[] = Array.isArray(weekdayLongRaw) ? weekdayLongRaw : [];
	// Local draft input for the monthly day-of-month picker. Kept here so it
	// survives re-renders of `renderModeFields` (which is a plain function,
	// not a component, so it can't call hooks itself).
	const [daysOfMonthDraft, setDaysOfMonthDraft] = useState("");
	// Phase 2: where this task runs and how to behave on session contention.
	// New tasks default to the session selected at creation time, so a later
	// manual agent switch does not make the task drift into another conversation.
	const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
	const [sessionTarget, setSessionTarget] = useState<SessionTarget>(
		editableSessionTarget(existing?.sessionTarget),
	);
	const [concurrencyPolicy, setConcurrencyPolicy] = useState<ConcurrencyPolicy>(
		existing?.concurrencyPolicy ?? "skip",
	);
	const [timeoutMinutes, setTimeoutMinutes] = useState<number>(
		existing?.timeoutMinutes ?? 0,
	);
	const [newSessionPurpose, setNewSessionPurpose] = useState(
		existing?.sessionTarget?.kind === "new" ? existing.sessionTarget.purpose : "",
	);
	// Initialize from the target task once per mount. Callers remount the form
	// (via `key`) when they switch between create / edit, so re-running this on
	// every `existing` identity change would only risk clobbering in-progress
	// edits when the parent refreshes its task list in the background.
	useEffect(() => {
		let cancelled = false;
		setName(existing?.name ?? "");
		setPrompt(existing?.prompt ?? "");
		setSpec(existing?.schedule ?? blankSpec());
		setEnabled(existing?.enabled ?? true);
		const nextTarget = editableSessionTarget(existing?.sessionTarget);
		setSessionTarget(nextTarget);
		setConcurrencyPolicy(existing?.concurrencyPolicy ?? "skip");
		setTimeoutMinutes(existing?.timeoutMinutes ?? 0);
		setNewSessionPurpose(nextTarget.kind === "new" ? nextTarget.purpose : "");
		setError(null);
		setSaving(false);
		(async () => {
			try {
				const state = await getSessionState().catch(() => null);
				if (cancelled) return;
				const activeSessionId = state?.sessionId;
				setCurrentSessionId(activeSessionId);
				setSessionTarget(
					editableSessionTarget(existing?.sessionTarget, activeSessionId),
				);
			} catch {
				/* Keep local safe defaults. */
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (isEdit) return;
		let cancelled = false;
		(async () => {
			try {
				const policy = await getSchedulerPolicy();
				if (cancelled) return;
				const nextTarget = editableSessionTarget(policy.defaultSessionTarget, currentSessionId);
				setSessionTarget(nextTarget.kind === "pinned" && !nextTarget.sessionId
					? defaultSessionTarget(currentSessionId)
					: nextTarget);
				setConcurrencyPolicy(policy.concurrency ?? "skip");
				setTimeoutMinutes(policy.timeoutMinutes ?? 0);
				setNewSessionPurpose(nextTarget.kind === "new" ? nextTarget.purpose : "");
			} catch {
				/* Keep local safe defaults. */
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isEdit]);

	const resolveSessionTargetForSave = async (): Promise<SessionTarget> => {
		if (sessionTarget.kind !== "pinned" || sessionTarget.sessionId) return sessionTarget;
		const state = currentSessionId ? null : await getSessionState().catch(() => null);
		const sessionId = currentSessionId ?? state?.sessionId;
		if (!sessionId) {
			throw new Error(t("schedule.sessionPinnedMissing"));
		}
		return { ...sessionTarget, sessionId };
	};

	const canSave = useMemo(() => {
		if (!name.trim()) return false;
		if (!prompt.trim()) return false;
		if (spec.mode === "daily" || spec.mode === "weekdays") {
			return (spec.times?.length ?? 0) > 0;
		}
		if (spec.mode === "weekly") {
			return (spec.times?.length ?? 0) > 0 && (spec.weekdays?.length ?? 0) > 0;
		}
		if (spec.mode === "monthly") {
			return (spec.times?.length ?? 0) > 0 && (spec.daysOfMonth?.length ?? 0) > 0;
		}
		if (spec.mode === "cron") {
			return !!spec.cron?.expression?.trim();
		}
		if (spec.mode === "every_n_minutes" || spec.mode === "every_n_hours") {
			return (spec.everyN?.n ?? 0) >= 1;
		}
		return false;
	}, [name, prompt, spec]);

	const handleSave = async () => {
		if (!canSave || saving) return;
		setError(null);
		setSaving(true);
		try {
			const targetForSave = await resolveSessionTargetForSave();
			if (isEdit && existing) {
				const updated = await updateScheduledTask(
					existing.id,
					{ name, prompt, schedule: spec, enabled, sessionTarget: targetForSave, concurrencyPolicy, timeoutMinutes },
					scope,
					workspaceId,
				);
				onSaved(updated);
			} else {
				const created = await createScheduledTask({
					name,
					prompt,
					scope,
					workspaceId,
					schedule: spec,
					enabled,
					createdBy: "user",
					sessionTarget: targetForSave,
					concurrencyPolicy,
					timeoutMinutes,
				});
				onSaved(created);
			}
			// Closing is the caller's job: it already knows whether to dismiss
			// the modal / popover or fall back to the task list.
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	// ---- Per-mode field renderers -----

	const renderModeFields = () => {
		switch (spec.mode) {
			case "every_n_minutes":
			case "every_n_hours":
				return (
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted">{t("schedule.n")}</span>
						<input
							type="number"
							min={1}
							max={spec.mode === "every_n_hours" ? 23 : 59}
							value={spec.everyN?.n ?? 1}
							onChange={(e) => {
								const n = Math.max(1, Number(e.target.value || 1));
								setSpec({
									...spec,
									everyN: {
										n,
										unit: spec.mode === "every_n_hours" ? "hour" : "minute",
									},
								});
							}}
							className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
						/>
						<span className="text-xs text-muted">
							{spec.mode === "every_n_hours" ? t("schedule.hour") : t("schedule.minute")}
						</span>
					</div>
				);
			case "daily":
				return (
					<Field label={t("schedule.time")}>
						<TimePointChips
							value={spec.times ?? []}
							onChange={(times) => setSpec({ ...spec, times })}
						/>
					</Field>
				);
			case "weekdays":
				return (
					<Field label={t("schedule.time")}>
						<TimePointChips
							value={spec.times ?? []}
							onChange={(times) => setSpec({ ...spec, times })}
						/>
					</Field>
				);
			case "weekly": {
				const selected = spec.weekdays ?? [];
				const toggle = (d: Weekday) => {
					const next = selected.includes(d)
						? selected.filter((x: Weekday) => x !== d)
						: [...selected, d].sort();
					setSpec({ ...spec, weekdays: next });
				};
				return (
					<div className="space-y-3">
						<Field label={t("schedule.weekdays")}>
							<div className="flex flex-wrap gap-1.5">
								{weekdayShort.map((label, idx) => {
									const d = idx as Weekday;
									const on = selected.includes(d);
									return (
										<button
											key={d}
											type="button"
											onClick={() => toggle(d)}
											className={cn(
												"h-8 w-8 rounded-full border text-xs transition-colors",
												on
													? "border-accent bg-accent text-accent-fg"
													: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
											)}
											title={weekdayLong[idx]}
										>
											{label}
										</button>
									);
								})}
							</div>
						</Field>
						<Field label={t("schedule.time")}>
							<TimePointChips
								value={spec.times ?? []}
								onChange={(times) => setSpec({ ...spec, times })}
							/>
						</Field>
					</div>
				);
			}
			case "monthly": {
				const days = spec.daysOfMonth ?? [];
				const addDay = (n: number) => {
					if (n < 1 || n > 31) return;
					const next = Array.from(new Set([...days, n])).sort((a, b) => a - b);
					setSpec({ ...spec, daysOfMonth: next });
				};
				const removeDay = (n: number) => {
					setSpec({ ...spec, daysOfMonth: days.filter((x: number) => x !== n) });
				};
				const draft = daysOfMonthDraft;
				const setDraft = setDaysOfMonthDraft;
				return (
					<div className="space-y-3">
						<Field label={t("schedule.daysOfMonth")}>
							<div className="space-y-1.5">
								<div className="flex flex-wrap gap-1.5">
									{days.map((d: number) => (
										<span
											key={d}
											className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-fg"
										>
											<span className="font-mono">{d}</span>
											<button
												type="button"
												onClick={() => removeDay(d)}
												className="ml-0.5 text-muted hover:text-danger"
											>
												×
											</button>
										</span>
									))}
								</div>
								<div className="flex items-center gap-1">
									<input
										type="number"
										min={1}
										max={31}
										value={draft}
										placeholder="1-31"
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												const n = Number(draft);
												if (!Number.isNaN(n)) addDay(n);
												setDraft("");
											}
										}}
										className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
									/>
									<button
										type="button"
										onClick={() => {
											const n = Number(draft);
											if (!Number.isNaN(n)) addDay(n);
											setDraft("");
										}}
										className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
									>
										+
									</button>
								</div>
							</div>
						</Field>
						<Field label={t("schedule.time")}>
							<TimePointChips
								value={spec.times ?? []}
								onChange={(times) => setSpec({ ...spec, times })}
							/>
						</Field>
					</div>
				);
			}
			case "cron":
				return (
					<Field label={t("schedule.expression")} hint="min hour day month weekday">
						<input
							type="text"
							value={spec.cron?.expression ?? ""}
							placeholder="0 9 * * *"
							onChange={(e) => setSpec({ ...spec, cron: { expression: e.target.value, tz: spec.cron?.tz } })}
							className="h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
						/>
						{spec.cron?.tz !== undefined && (
							<input
								type="text"
								value={spec.cron.tz ?? ""}
								placeholder="Asia/Shanghai (optional)"
								onChange={(e) => setSpec({ ...spec, cron: { expression: spec.cron?.expression ?? "", tz: e.target.value } })}
								className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-3 text-xs text-fg outline-none focus:border-accent"
							/>
						)}
					</Field>
				);
		}
	};

	return (
		<div className="flex min-h-0 flex-col">
			<div
				className={cn(
					"min-h-0 overflow-y-auto pr-1",
					compact ? "max-h-[52vh] space-y-3" : "max-h-[70vh] space-y-4",
				)}
			>
				{error && <ErrorBanner message={error} />}

				<Field label={t("schedule.name")}>
					<input
						type="text"
						value={name}
						placeholder={t("schedule.namePlaceholder")}
						onChange={(e) => setName(e.target.value)}
						className={cn(
							"rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent",
							compact && "py-2 text-sm",
						)}
					/>
				</Field>

				<div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[180px_1fr] sm:items-center">
					<span className="text-xs font-medium text-muted">{t("schedule.mode")}</span>
					<ScheduleModePicker
						value={spec.mode}
						onChange={(mode) => {
							// Switching mode resets the mode-specific fields so canSave()
							// never gets stuck because the previous mode left an unrelated
							// field undefined. Drop everyN / times / weekdays / daysOfMonth
							// / cron first, then layer on sensible defaults for the new mode.
							const base: ScheduleSpec = {
								...spec,
								mode,
								everyN: undefined,
								times: undefined,
								weekdays: undefined,
								daysOfMonth: undefined,
								cron: undefined,
							};
							let next: ScheduleSpec = base;
							if (mode === "every_n_minutes") {
								next = { ...base, everyN: { n: 15, unit: "minute" } };
							} else if (mode === "every_n_hours") {
								next = { ...base, everyN: { n: 1, unit: "hour" } };
							} else if (mode === "daily" || mode === "weekdays" || mode === "weekly" || mode === "monthly") {
								next = { ...base, times: [{ hour: 9, minute: 0 }] };
								if (mode === "weekdays") next = { ...next, weekdays: [1, 2, 3, 4, 5] };
								if (mode === "weekly") next = { ...next, weekdays: [1, 3, 5] };
								if (mode === "monthly") next = { ...next, daysOfMonth: [1] };
							} else if (mode === "cron") {
								next = { ...base, cron: { expression: "0 9 * * *" } };
							}
							setSpec(next);
						}}
					/>
					<span className="self-start text-xs font-medium text-muted">{t("schedule.details")}</span>
					<div>{renderModeFields()}</div>
				</div>

				<Field label={t("schedule.taskContent")} hint={t("schedule.taskContentHint")}>
					<textarea
						value={prompt}
						placeholder={t("schedule.taskContentPlaceholder")}
						onChange={(e) => setPrompt(e.target.value)}
						rows={compact ? 3 : 3}
						className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent"
					/>
				</Field>

				<div className="space-y-1.5">
					<div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5 text-[10px] font-medium text-muted">
						<span className="px-2">{t("schedule.sessionTargetShort")}</span>
						<span className="px-2">{t("schedule.concurrencyShort")}</span>
						<span className="px-2">{t("schedule.timeoutShort")}</span>
					</div>
					<div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
						<Select
							size={compact ? "sm" : "md"}
							value={sessionTarget.kind}
							title={t(
								sessionTarget.kind === "pinned"
									? "schedule.sessionPinnedHint"
									: "schedule.sessionNewHint",
							)}
							options={[
								{ value: "pinned", label: t("schedule.sessionPinned") },
								{ value: "new", label: t("schedule.sessionNew") },
							]}
							onChange={(v) => {
								if (v === "pinned") setSessionTarget(defaultSessionTarget(currentSessionId));
								else setSessionTarget({ kind: "new", purpose: newSessionPurpose });
							}}
						/>
						<Select
							size={compact ? "sm" : "md"}
							value={concurrencyPolicy}
							title={t(`schedule.concurrency_${concurrencyPolicy}_hint`)}
							options={[
								{ value: "skip", label: t("schedule.concurrency_skip"), hint: t("schedule.concurrency_skip_hint") },
								{ value: "queue", label: t("schedule.concurrency_queue"), hint: t("schedule.concurrency_queue_hint") },
								{ value: "preempt", label: t("schedule.concurrency_preempt"), hint: t("schedule.concurrency_preempt_hint") },
							]}
							onChange={(v) => setConcurrencyPolicy(v as ConcurrencyPolicy)}
						/>
						<div className="flex items-center gap-1">
							<input
								type="number"
								min={0}
								max={1440}
								value={timeoutMinutes}
								onChange={(e) => setTimeoutMinutes(Math.max(0, Number(e.target.value || 0)))}
								className={cn(
									"rounded-lg border border-border bg-surface px-2 text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent",
									compact ? "h-8 w-14 text-xs" : "h-9 w-16",
								)}
								placeholder="0"
								title={t("schedule.timeoutHint")}
							/>
							<span className="text-xs text-muted">m</span>
						</div>
					</div>
					{sessionTarget.kind === "new" && (
						<input
							type="text"
							placeholder={t("schedule.sessionNewPurposePlaceholder")}
							value={newSessionPurpose}
							onChange={(e) => {
								const v = e.target.value;
								setNewSessionPurpose(v);
								if (sessionTarget.kind === "new") setSessionTarget({ kind: "new", purpose: v });
							}}
							className={cn(
								"rounded-lg border border-border bg-surface px-2 text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent",
								compact ? "h-8" : "h-9",
							)}
						/>
					)}
				</div>
				<SchedulePreview spec={spec} />

				<div className="flex items-center gap-2 text-xs text-muted">
					<span>{t("schedule.scope")}:</span>
					<span
						className={cn(
							"rounded-full px-2 py-0.5 text-[11px]",
							scope === "main" ? "bg-surface-2 text-accent" : "bg-surface-2 text-fg",
						)}
					>
						{scope === "main" ? t("schedule.scopeMain") : t("schedule.scopeWorkspace")}
					</span>
				</div>
			</div>

			<div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
				<label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
						className="accent-accent"
					/>
					{t("schedule.enabled")}
				</label>
				<div className="flex items-center gap-2">
					<Button tone="neutral" variant="ghost" size={compact ? "sm" : "md"} onClick={onCancel} disabled={saving}>
						{t("schedule.cancel")}
					</Button>
					<Button tone="accent" size={compact ? "sm" : "md"} onClick={handleSave} disabled={!canSave || saving}>
						{saving ? <Spinner /> : null}
						{t("schedule.save")}
					</Button>
				</div>
			</div>
		</div>
	);
}
