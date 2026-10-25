/**
 * Local scheduler types — re-exports from packages/protocol for convenience and
 * adds internal helpers (e.g. fire snapshots) that the protocol doesn't need
 * to know about.
 */

import type {
	ScheduleMode,
	ScheduleSpec,
	ScheduledTask,
	ScheduledTaskRun,
	ScheduledTaskSummary,
	TimeOfDay,
	Weekday,
} from "../../../packages/protocol/index.js";

export type {
	ScheduleMode,
	ScheduleSpec,
	ScheduledTask,
	ScheduledTaskRun,
	ScheduledTaskSummary,
	TimeOfDay,
	Weekday,
};

/** Minimum valid value of N for every_n_minutes / every_n_hours. */
export const SCHEDULE_MIN_INTERVAL_N = 1;
/** Maximum valid value of N — anything larger would be obviously wrong. */
export const SCHEDULE_MAX_INTERVAL_N = 24 * 60 * 7;

/** Maximum name length (truncated on creation if longer). */
export const SCHEDULE_NAME_MAX = 80;

/**
 * Generate a short, URL-safe, collision-resistant id for a task.
 * Format: `st_<16 hex>` (8 random bytes, hex-encoded). 24 chars total.
 */
export function generateTaskId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return `st_${hex}`;
}

/**
 * Default task name derived from prompt text. Strips whitespace, trims to
 * SCHEDULE_NAME_MAX. Falls back to "Untitled task" if the prompt is empty.
 */
export function defaultTaskName(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	if (!flat) return "Untitled task";
	return flat.length > SCHEDULE_NAME_MAX ? flat.slice(0, SCHEDULE_NAME_MAX) : flat;
}

/** Result of validating a ScheduleSpec — returns the first error or null. */
export function validateScheduleSpec(spec: ScheduleSpec): string | null {
	switch (spec.mode) {
		case "every_n_minutes":
		case "every_n_hours": {
			if (!spec.everyN) return "everyN is required for interval modes";
			const { n, unit } = spec.everyN;
			if (!Number.isFinite(n) || n < SCHEDULE_MIN_INTERVAL_N || n > SCHEDULE_MAX_INTERVAL_N) {
				return `Interval N must be between ${SCHEDULE_MIN_INTERVAL_N} and ${SCHEDULE_MAX_INTERVAL_N}`;
			}
			if (unit === "minute" && n < 1) return "Minutes must be >= 1";
			if (unit === "hour" && n < 1) return "Hours must be >= 1";
			return null;
		}
		case "daily":
		case "weekdays":
		case "weekly":
		case "monthly": {
			if (!spec.times || spec.times.length === 0) {
				return "At least one time point is required";
			}
			for (const t of spec.times) {
				if (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23) return "hour must be 0-23";
				if (!Number.isInteger(t.minute) || t.minute < 0 || t.minute > 59) return "minute must be 0-59";
			}
			if (spec.mode === "weekly") {
				if (!spec.weekdays || spec.weekdays.length === 0) return "Select at least one weekday";
				for (const d of spec.weekdays) {
					if (!Number.isInteger(d) || d < 0 || d > 6) return "weekday must be 0-6";
				}
			}
			if (spec.mode === "monthly") {
				if (!spec.daysOfMonth || spec.daysOfMonth.length === 0) return "Select at least one day of month";
				for (const d of spec.daysOfMonth) {
					if (!Number.isInteger(d) || d < 1 || d > 31) return "dayOfMonth must be 1-31";
				}
			}
			return null;
		}
		case "cron": {
			if (!spec.cron || !spec.cron.expression) return "cron.expression is required";
			return null;
		}
		default: {
			const unknown = spec as { mode?: string };
			return `Unknown schedule mode: ${unknown.mode}`;
		}
	}
}