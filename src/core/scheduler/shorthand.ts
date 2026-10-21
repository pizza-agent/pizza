/**
 * Schedule shorthand parser.
 *
 * Converts an agent-friendly string into the canonical ScheduleSpec used by
 * the scheduler engine. Supports three forms, tried in priority order:
 *   1. Standard 5-field cron expression (minutes hours day month weekday,
 *      using star / slash / dash / comma tokens).
 *   2. "every" phrase, e.g. "every 2h", "every 30 minutes".
 *   3. Bare interval, e.g. "30m", "2h", "45min", "1hour".
 *
 * Reuses cron.ts (validateCron, cronToSpec) and types.ts (validateScheduleSpec,
 * interval bounds). No scheduling logic is duplicated.
 */

import type { ScheduleSpec } from "../../../packages/protocol/index.js";
import { cronToSpec, validateCron } from "./cron.js";
import {
	SCHEDULE_MAX_INTERVAL_N,
	SCHEDULE_MIN_INTERVAL_N,
	validateScheduleSpec,
} from "./types.js";

export type ParsedShorthand =
	| { ok: true; spec: ScheduleSpec }
	| { ok: false; error: string };

/**
 * Parse a shorthand schedule string.
 *
 * Returns `{ ok: true, spec }` on success, or `{ ok: false, error }` with a
 * human-readable message (surfaced to the agent / user).
 */
export function parseScheduleShorthand(input: string): ParsedShorthand {
	const raw = input.trim();
	if (!raw) return { ok: false, error: "schedule is empty" };

	// 1) Cron: 5 whitespace-separated fields, each a valid cron token (digits,
	//    star, slash, dash, comma). We do NOT require a metacharacter — an
	//    all-numeric expression like "0 9 1 1 1" (9am every Jan 1) is a valid
	//    cron and must be accepted. Every field must look like a cron field so
	//    that interval phrases (e.g. "every 2h", which has 2 fields) and free
	//    text fall through to the interval parser instead.
	const fields = raw.split(/\s+/);
	const looksCron = fields.length === 5 && fields.every((f) => /^[\d*/\-,]+$/.test(f));
	if (looksCron) {
		const verr = validateCron(raw);
		if (verr) return { ok: false, error: `invalid cron expression: ${verr}` };
		const spec = cronToSpec(raw);
		const serr = validateScheduleSpec(spec);
		if (serr) return { ok: false, error: serr };
		return { ok: true, spec };
	}

	// 2) / 3) Interval: "every <n> <unit>"  OR  bare "<n><unit>".
	//    unit covers minute/hour variants.
	const intervalMatch = raw
		.toLowerCase()
		.match(/^(?:every\s+)?(\d+)\s*(min(?:ute)?s?|m|h(?:ou?rs?|rs?)?)$/);
	if (intervalMatch) {
		const n = Number(intervalMatch[1]);
		const unitToken = intervalMatch[2];
		if (!Number.isFinite(n) || n < SCHEDULE_MIN_INTERVAL_N || n > SCHEDULE_MAX_INTERVAL_N) {
			return {
				ok: false,
				error: `interval N must be between ${SCHEDULE_MIN_INTERVAL_N} and ${SCHEDULE_MAX_INTERVAL_N}`,
			};
		}
		const isHour = unitToken.startsWith("h");
		const spec: ScheduleSpec = isHour
			? { mode: "every_n_hours", everyN: { n, unit: "hour" } }
			: { mode: "every_n_minutes", everyN: { n, unit: "minute" } };
		const verr = validateScheduleSpec(spec);
		if (verr) return { ok: false, error: verr };
		return { ok: true, spec };
	}

	return {
		ok: false,
		error: `unrecognized schedule "${raw}". Use an interval ("30m", "every 2h") or a cron expression ("0 9 * * 1-5").`,
	};
}
