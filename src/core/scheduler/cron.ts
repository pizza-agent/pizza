/**
 * Mini cron parser and ScheduleSpec ↔ cron expression conversion.
 *
 * Supported cron grammar (5 fields, space-separated):
 *   field    range   special
 *   minute   0-59
 *   hour     0-23
 *   day      1-31
 *   month    1-12
 *   weekday  0-6     (0 = Sunday, 7 also accepted as Sunday)
 *
 * Each field accepts:
 *   *        any value
 *   n        a single value
 *   n,m,k    a list
 *   n-m      a range (inclusive)
 *   *\/n     every n (step)
 *   n-m/s    every s in [n, m]
 *
 * Day-of-month and day-of-week follow Vixie cron semantics: when both fields
 * are restricted, the trigger fires when EITHER matches (OR); when one is `*`
 * the other alone decides; when both are `*` every day matches. See
 * `dayMatchesVixie` below.
 *
 * The parser is intentionally minimal (no L, W, #, ? extensions) so the
 * surface area stays small and predictable.
 */

import type { ScheduleMode, ScheduleSpec, TimeOfDay, Weekday } from "../../../packages/protocol/index.js";

// --- Field parsing ----------------------------------------------------------

interface CronField {
	values: number[]; // sorted, unique, expanded
	star: boolean; // true if `*` (full range)
}

function expandStep(start: number, end: number, step: number): number[] {
	const out: number[] = [];
	if (step <= 0) return [start];
	for (let v = start; v <= end; v += step) out.push(v);
	return out;
}

function parseField(raw: string, min: number, max: number, sundayIs7 = false): CronField {
	let trimmed = raw.trim();
	if (!trimmed) throw new Error(`empty cron field`);

	// Sunday-as-7 normalization for the weekday field happens per-value below
	// (see the sundayIs7 block). We deliberately do NOT rewrite the raw string
	// here: a regex like /\b7\b/ would corrupt ranges such as "5-7" → "5-0".

	const tokens = trimmed.split(",");
	const all: number[] = [];
	let star = false;

	for (const tok of tokens) {
		const t = tok.trim();
		if (!t) throw new Error(`empty cron token in "${raw}"`);

		if (t === "*") {
			star = true;
			for (let v = min; v <= max; v++) all.push(v);
			continue;
		}

		let stepStr: string | undefined;
		let base = t;
		if (t.includes("/")) {
			const idx = t.indexOf("/");
			base = t.slice(0, idx);
			stepStr = t.slice(idx + 1);
		}

		let lo: number;
		let hi: number;
		if (base === "*") {
			lo = min;
			hi = max;
		} else if (base.includes("-")) {
			const parts = base.split("-");
			if (parts.length !== 2) throw new Error(`invalid range in "${t}"`);
			lo = Number(parts[0]);
			hi = Number(parts[1]);
		} else {
			const n = Number(base);
			if (!Number.isFinite(n)) throw new Error(`invalid number in "${t}"`);
			lo = n;
			hi = base.includes("-") ? n : n; // single value handled below
		}

		if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`invalid range in "${t}"`);
		// Weekday field also accepts 7 (=Sunday); it is normalized to 0 below,
		// after expansion, so ranges like "5-7" or "0-7" stay well-formed.
		const effectiveMax = sundayIs7 ? max + 1 : max;
		if (lo < min || hi > effectiveMax || lo > hi) {
			throw new Error(`range out of bounds in "${t}" (allowed ${min}-${max})`);
		}

		let values: number[];
		if (stepStr !== undefined) {
			const step = Number(stepStr);
			if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid step in "${t}"`);
			values = expandStep(lo, hi, step);
		} else if (base.includes("-")) {
			values = expandStep(lo, hi, 1);
		} else {
			values = [lo];
		}

		// Sunday-as-7 → 0 normalization
		if (sundayIs7) {
			for (let i = 0; i < values.length; i++) {
				const v = values[i]!;
				if (v === 7) values[i] = 0;
			}
		}

		for (const v of values) all.push(v);
	}

	const values = Array.from(new Set(all)).sort((a, b) => a - b);
	return { values, star };
}

// --- Top-level parse --------------------------------------------------------

export interface ParsedCron {
	minute: CronField;
	hour: CronField;
	day: CronField;
	month: CronField;
	weekday: CronField;
}

/**
 * Parse a 5-field cron expression. Throws on any syntax error.
 * Throws include a user-friendly message because users see them in the UI.
 */
export function parseCron(expression: string): ParsedCron {
	const trimmed = expression.trim();
	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Cron must have 5 fields (got ${fields.length})`);
	}
	try {
		const minute = parseField(fields[0]!, 0, 59);
		const hour = parseField(fields[1]!, 0, 23);
		const day = parseField(fields[2]!, 1, 31);
		const month = parseField(fields[3]!, 1, 12);
		const weekday = parseField(fields[4]!, 0, 6, true);
		return { minute, hour, day, month, weekday };
	} catch (e) {
		throw new Error(`Invalid cron "${expression}": ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Vixie cron day-of-month / day-of-week semantics:
 *   - both `*`                              → match every day
 *   - day `*`, weekday restricted           → match by weekday only
 *   - day restricted, weekday `*`           → match by day-of-month only
 *   - both restricted                       → match if EITHER matches (OR)
 *
 * The plain "OR" rule in standard cron docs only applies to the last case;
 * the first three are "AND with the unrestricted field disabled". Our
 * parser already records `star` per field so we can dispatch on it here.
 */
function dayMatchesVixie(day: CronField, weekday: CronField, localDay: number, localWeekday: number): boolean {
	if (day.star && weekday.star) return true;
	if (day.star) return weekday.values.includes(localWeekday);
	if (weekday.star) return day.values.includes(localDay);
	return day.values.includes(localDay) || weekday.values.includes(localWeekday);
}

/**
 * Validate a cron expression without throwing. Returns null on success or
 * a human-readable error message on failure.
 */
export function validateCron(expression: string): string | null {
	try {
		parseCron(expression);
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

// --- Next-fire computation --------------------------------------------------

/**
 * Compute the next epoch-ms timestamp at or after `from` that matches the
 * cron expression. Returns null if no match is found within `maxYearsAhead`.
 * Iterative: starts at `from` and advances at least one second per loop.
 *
 * Day-of-month / day-of-week use Vixie cron semantics (see `dayMatchesVixie`):
 * when both fields are restricted, either matches; when one is `*` the other
 * alone decides. Plain OR semantics (as in some cron libraries) are NOT used.
 */
export function cronNextRun(
	expression: string,
	from: number,
	opts: { maxYearsAhead?: number; tzOffsetMinutes?: number } = {},
): number | null {
	const parsed = parseCron(expression);
	const maxYearsAhead = opts.maxYearsAhead ?? 5;
	const tzOffsetMin = opts.tzOffsetMinutes ?? new Date(from).getTimezoneOffset();
	const ceiling = from + maxYearsAhead * 365.25 * 24 * 3600 * 1000;

	// Work in UTC minutes-of-day to keep arithmetic simple, then map back.
	// Strategy: scan forward minute by minute in UTC, but only emit candidates
	// when ALL fields match. For each candidate we also need to honor the
	// caller-supplied timezone offset.

	const start = new Date(from);
	// Round UP to the next minute.
	const startUtc = Date.UTC(
		start.getUTCFullYear(),
		start.getUTCMonth(),
		start.getUTCDate(),
		start.getUTCHours(),
		start.getUTCMinutes(),
		0,
		0,
	);
	let candidate = startUtc + 60_000; // strictly greater than `from`

	const endCandidate = ceiling;
	const stepMs = 60_000;

	let lastLocalDay = -1;
	let lastLocalMonth = -1;
	while (candidate <= endCandidate) {
		// Convert UTC instant to "local" components per tzOffsetMin.
		// tzOffsetMin > 0 means local is behind UTC (e.g. -300 for EST means
		// tzOffsetMin is 300 because JS returns positive for behind-UTC).
		const local = new Date(candidate - tzOffsetMin * 60_000);
		const localMinute = local.getUTCMinutes();
		const localHour = local.getUTCHours();
		const localDay = local.getUTCDate();
		const localMonth = local.getUTCMonth() + 1;
		const localWeekday = local.getUTCDay();

		// Fast-skip whole days when day-of-month / month / weekday can't match.
		const dayChanged = localDay !== lastLocalDay || localMonth !== lastLocalMonth;
		if (dayChanged) {
			lastLocalDay = localDay;
			lastLocalMonth = localMonth;
			if (!parsed.month.values.includes(localMonth)) {
				// Skip to the first day of the next matching month.
				candidate = firstOfNextMonthUtc(candidate, tzOffsetMin);
				continue;
			}
			if (!dayMatchesVixie(parsed.day, parsed.weekday, localDay, localWeekday)) {
				// Skip to next midnight (local).
				candidate = nextLocalMidnightUtc(candidate, tzOffsetMin);
				continue;
			}
		}

		if (
			parsed.minute.values.includes(localMinute) &&
			parsed.hour.values.includes(localHour) &&
			dayMatchesVixie(parsed.day, parsed.weekday, localDay, localWeekday)
		) {
			return candidate;
		}

		candidate += stepMs;
	}
	return null;
}

function firstOfNextMonthUtc(candidateUtc: number, tzOffsetMin: number): number {
	// Roll forward to the 1st of next month in local time, midnight.
	const local = new Date(candidateUtc - tzOffsetMin * 60_000);
	const nextMonth = local.getUTCMonth() + 1;
	const year = local.getUTCFullYear() + (nextMonth > 11 ? 1 : 0);
	const realMonth = nextMonth % 12;
	return Date.UTC(year, realMonth, 1, 0, 0, 0, 0) + tzOffsetMin * 60_000;
}

function nextLocalMidnightUtc(candidateUtc: number, tzOffsetMin: number): number {
	const local = new Date(candidateUtc - tzOffsetMin * 60_000);
	const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0, 0));
	return next.getTime() + tzOffsetMin * 60_000;
}

// --- ScheduleSpec ↔ cron conversion -----------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function fmtTime(t: TimeOfDay): string {
	return `${pad2(t.minute)} ${pad2(t.hour)}`;
}

function fmtRange(values: number[]): string {
	// Compact representation: single value → "n"; range → "a-b"; sparse → "a,b,c"
	if (values.length === 0) return "*";
	if (values.length === 1) return String(values[0]);
	const isContiguous = values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
	if (isContiguous) return `${values[0]}-${values[values.length - 1]}`;
	return values.join(",");
}

function uniqueSorted<T extends number>(arr: readonly T[]): T[] {
	return Array.from(new Set(arr)).sort((a, b) => a - b) as T[];
}

/**
 * Convert a ScheduleSpec to a 5-field cron expression. Throws if the spec
 * cannot be expressed as standard cron (e.g. weird everyN combinations).
 *
 * Returned expression is always in UTC — the caller is responsible for any
 * timezone display (the spec's cron.tz is a hint for UIs, not a parser input).
 */
export function specToCron(spec: ScheduleSpec): string {
	switch (spec.mode) {
		case "every_n_minutes": {
			if (!spec.everyN) throw new Error("everyN is required");
			if (spec.everyN.unit === "minute") {
				if (spec.everyN.n < 1 || spec.everyN.n > 59) {
					throw new Error("minute interval must be 1-59");
				}
				if (spec.everyN.n === 1) return "* * * * *";
				return `*/${spec.everyN.n} * * * *`;
			}
			// hour → minute must be 0 for hourly cron alignment.
			if (spec.everyN.n < 1 || spec.everyN.n > 23) {
				throw new Error("hour interval must be 1-23");
			}
			return `0 */${spec.everyN.n} * * *`;
		}
		case "every_n_hours": {
			if (!spec.everyN) throw new Error("everyN is required");
			if (spec.everyN.unit !== "hour") throw new Error("expected unit=hour");
			if (spec.everyN.n < 1 || spec.everyN.n > 23) {
				throw new Error("hour interval must be 1-23");
			}
			return `0 */${spec.everyN.n} * * *`;
		}
		case "daily": {
			const times = (spec.times ?? []).slice();
			if (times.length === 0) throw new Error("at least one time point required");
			const minutes = uniqueSorted(times.map((t) => t.minute));
			const hours = uniqueSorted(times.map((t) => t.hour));
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * *`;
		}
		case "weekdays": {
			const times = (spec.times ?? []).slice();
			if (times.length === 0) throw new Error("at least one time point required");
			const minutes = uniqueSorted(times.map((t) => t.minute));
			const hours = uniqueSorted(times.map((t) => t.hour));
			// Weekdays in cron: 1-5 (Mon-Fri).
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * 1-5`;
		}
		case "weekly": {
			const times = (spec.times ?? []).slice();
			const weekdays = (spec.weekdays ?? []).slice();
			if (times.length === 0) throw new Error("at least one time point required");
			if (weekdays.length === 0) throw new Error("at least one weekday required");
			const minutes = uniqueSorted(times.map((t) => t.minute));
			const hours = uniqueSorted(times.map((t) => t.hour));
			const wd = uniqueSorted(weekdays).map((d) => (d === 0 ? 7 : d)); // cron uses 7 for Sunday
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * ${fmtRange(wd)}`;
		}
		case "monthly": {
			const times = (spec.times ?? []).slice();
			const days = (spec.daysOfMonth ?? []).slice();
			if (times.length === 0) throw new Error("at least one time point required");
			if (days.length === 0) throw new Error("at least one day required");
			const minutes = uniqueSorted(times.map((t) => t.minute));
			const hours = uniqueSorted(times.map((t) => t.hour));
			return `${fmtRange(minutes)} ${fmtRange(hours)} ${fmtRange(uniqueSorted(days))} * *`;
		}
		case "cron": {
			if (!spec.cron?.expression) throw new Error("cron.expression is required");
			// Re-validate to surface typos. validateCron() returns a non-null
			// error message instead of throwing, so we must propagate it.
			const err = validateCron(spec.cron.expression);
			if (err) throw new Error(`invalid cron expression: ${err}`);
			return spec.cron.expression;
		}
		default: {
			const unknown = spec as { mode?: string };
			throw new Error(`Unknown mode: ${unknown.mode}`);
		}
	}
}

/**
 * Convert a cron expression to a ScheduleSpec. Only succeeds for "nice"
 * expressions that fit one of the visual modes; arbitrary cron falls back to
 * mode: "cron".
 *
 * Conservative: if any field doesn't fit a clean visual pattern, returns
 * mode: "cron" so we never silently lose fidelity.
 */
export function cronToSpec(expression: string, tz?: string): ScheduleSpec {
	const parsed = parseCron(expression);

	const allMinutes = (m: CronField) => m.star && m.values.length === 60;
	const allHours = (h: CronField) => h.star && h.values.length === 24;
	const allDays = (d: CronField) => d.star && d.values.length === 31;
	const allMonths = (m: CronField) => m.star && m.values.length === 12;
	const isFullWeekdays = (w: CronField) =>
		w.values.length === 5 && w.values.join(",") === "1,2,3,4,5";
	const isFullWeekends = (w: CronField) =>
		w.values.length === 2 && w.values.join(",") === "0,6";

	// Interval forms: */N * * * *  or  0 */N * * *
	if (allHours(parsed.hour) && allDays(parsed.day) && allMonths(parsed.month)) {
		const mStep = parsed.minute.values[1]! - parsed.minute.values[0]!;
		const isEveryNMin = parsed.minute.star && mStep === 1 && parsed.minute.values.length === 60;
		if (isEveryNMin) {
			return { mode: "every_n_minutes", everyN: { n: 1, unit: "minute" } };
		}
		if (!parsed.minute.star && parsed.minute.values.length === 60 / mStep && parsed.minute.values[0] === 0) {
			return { mode: "every_n_minutes", everyN: { n: mStep, unit: "minute" } };
		}
	}

	if (
		parsed.minute.values.length === 1 && parsed.minute.values[0] === 0 &&
		allDays(parsed.day) && allMonths(parsed.month)
	) {
		const hStep = parsed.hour.values[1]! - parsed.hour.values[0]!;
		const isEveryNHour = parsed.hour.star && hStep === 1 && parsed.hour.values.length === 24;
		if (isEveryNHour) {
			return { mode: "every_n_hours", everyN: { n: 1, unit: "hour" } };
		}
		if (!parsed.hour.star && parsed.hour.values.length === 24 / hStep && parsed.hour.values[0] === 0) {
			return { mode: "every_n_hours", everyN: { n: hStep, unit: "hour" } };
		}
	}

	// daily / weekdays / weekly / monthly all share: minute × hour list.
	if (
		allDays(parsed.day) && allMonths(parsed.month) &&
		parsed.minute.values.every((v) => v >= 0 && v <= 59) &&
		parsed.hour.values.every((v) => v >= 0 && v <= 23)
	) {
		const times: TimeOfDay[] = [];
		for (const h of parsed.hour.values) {
			for (const m of parsed.minute.values) {
				times.push({ hour: h, minute: m });
			}
		}
		if (isFullWeekdays(parsed.weekday)) {
			return { mode: "weekdays", times, weekdays: [1, 2, 3, 4, 5] as Weekday[] };
		}
		if (isFullWeekends(parsed.weekday)) {
			return {
				mode: "weekly",
				times,
				weekdays: [0, 6] as Weekday[],
			};
		}
		if (parsed.weekday.star && parsed.weekday.values.length === 7) {
			return { mode: "daily", times };
		}
		// Specific weekdays
		if (!parsed.weekday.star && parsed.weekday.values.every((v) => v >= 0 && v <= 6)) {
			const wd = parsed.weekday.values.map((v) => (v === 7 ? 0 : v)) as Weekday[];
			return { mode: "weekly", times, weekdays: wd };
		}
	}

	// Monthly: a specific day list
	if (
		parsed.month.star && parsed.month.values.length === 12 &&
		parsed.weekday.star && parsed.weekday.values.length === 7 &&
		parsed.day.values.every((v) => v >= 1 && v <= 31)
	) {
		const times: TimeOfDay[] = [];
		for (const h of parsed.hour.values) {
			for (const m of parsed.minute.values) {
				times.push({ hour: h, minute: m });
			}
		}
		return { mode: "monthly", times, daysOfMonth: parsed.day.values };
	}

	// Fallback: keep the raw expression.
	return {
		mode: "cron",
		cron: { expression, tz },
	};
}