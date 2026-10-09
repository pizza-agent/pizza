import type { TFunction } from "i18next";
import type { DayOfMonth, ScheduleSpec, TimeOfDay, Weekday } from "@/lib/types";

/** Localized abbreviated weekday labels ("Sun".."Sat" in en). */
function weekdayAbbr(t: TFunction): string[] {
	const labels = t("schedule.weekdayAbbr", { returnObjects: true }) as unknown;
	return Array.isArray(labels) ? (labels as string[]) : [];
}

/** Format an HH:MM time for display. */
export function formatTimeOfDay(t: TimeOfDay): string {
	return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** Format nextRunAt for display. */
export function formatNextRun(at: number | null | undefined, t: TFunction): string {
	if (!at) return "—";
	const d = new Date(at);
	const now = Date.now();
	const diff = at - now;
	const time = d.toLocaleString();
	if (diff < 0) return `${time} (${t("schedule.summary.expired")})`;
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `${time} (${t("schedule.summary.inMinutes", { n: minutes })})`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${time} (${t("schedule.summary.inHours", { n: hours })})`;
	const days = Math.round(hours / 24);
	return `${time} (${t("schedule.summary.inDays", { n: days })})`;
}

/** Format a list of times for display (e.g. "09:00, 18:00"). */
function formatTimes(times: TimeOfDay[] | undefined): string {
	if (!times || times.length === 0) return "—";
	return times.map(formatTimeOfDay).join(", ");
}

/** Format days of month list. */
function formatDaysOfMonth(days: DayOfMonth[] | undefined): string {
	if (!days || days.length === 0) return "—";
	return days.join(", ");
}

/** Format weekdays list. */
function formatWeekdays(weekdays: Weekday[] | undefined, t: TFunction): string {
	if (!weekdays || weekdays.length === 0) return "—";
	const labels = weekdayAbbr(t);
	return weekdays.map((d) => labels[d] ?? String(d)).join(", ");
}

/** One-line human summary of a task's trigger, for dense list rows. */
export function describeSchedule(schedule: ScheduleSpec, t: TFunction): string {
	switch (schedule.mode) {
		case "every_n_minutes":
			return t("schedule.summary.everyNMinutes", { n: schedule.everyN?.n ?? "?" });
		case "every_n_hours":
			return t("schedule.summary.everyNHours", { n: schedule.everyN?.n ?? "?" });
		case "daily":
			return t("schedule.summary.daily", { times: formatTimes(schedule.times) });
		case "weekdays":
			return t("schedule.summary.weekdays", { times: formatTimes(schedule.times) });
		case "weekly":
			return t("schedule.summary.weekly", {
				days: formatWeekdays(schedule.weekdays, t),
				times: formatTimes(schedule.times),
			});
		case "monthly":
			return t("schedule.summary.monthly", {
				days: formatDaysOfMonth(schedule.daysOfMonth),
				times: formatTimes(schedule.times),
			});
		case "cron":
			return schedule.cron?.expression ?? "";
		default:
			return "";
	}
}
