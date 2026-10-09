/**
 * Natural-language → ScheduleSpec detection.
 *
 * Two-tier implementation:
 *
 *   1. DeterministicPatternDetector — pure regex/heuristics covering the
 *      ~80% case in Chinese and English. No LLM, no model latency, fully
 *      testable. Supports phrases like:
 *        - "remind me in X minutes: Y" / "X 分钟后提醒我 Y"
 *        - "remind me in X hours: Y" / "X 小时后提醒我 Y"
 *        - "tomorrow HH:MM Y" / "明天 HH:MM Y"
 *        - "day after tomorrow HH:MM Y" / "后天 HH:MM Y"
 *        - "每天 HH:MM Y" / "every day at HH:MM Y"
 *        - "工作日 HH:MM Y" / "weekdays at HH:MM Y"
 *        - "每周X HH:MM Y" / "every Monday HH:MM Y"
 *        - "每月 X 号 HH:MM Y" / "on the 15th of every month Y"
 *        - "remind me Y" / "提醒我 Y" with no schedule (returns null — too ambiguous)
 *
 *   2. ScheduleIntentDetector — interface that callers can implement for
 *      LLM-backed detection. The runtime uses the deterministic detector
 *      by default; UI components can opt into a richer implementation if
 *      one is registered.
 *
 * The chat UI uses detectScheduleIntent() at submit time (frontend-side
 * gateway) and falls back to a normal prompt when no schedule is detected.
 */

import type { ScheduleSpec, TimeOfDay, Weekday } from "@tomsun28/pizza-protocol";

export interface DetectedScheduleIntent {
	schedule: ScheduleSpec;
	prompt: string;
	/** Match confidence, 0-1. */
	confidence: number;
}

export interface ScheduleIntentDetector {
	detect(text: string, now?: Date): DetectedScheduleIntent | null;
}

const WEEKDAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_NAMES_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Format HH:MM (24h) — used both for matching and for building prompts. */
function parseTimeOfDay(s: string): TimeOfDay | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return { hour, minute };
}

function pickPrompt(after: string | undefined, fallback: string): string {
	const trimmed = (after ?? "").trim();
	if (!trimmed) return fallback;
	// Strip leading reminder phrases ("remind me to", "remind me" in en;
	// 提醒我 / 提醒 / 提醒一下 / 提醒我去做 in zh)
	return trimmed
		.replace(/^(提醒|提醒我|提醒一下|提醒我去做|remind me to|remind me|remind me about)\s*/i, "")
		.trim() || fallback;
}

function tomorrow(now: Date, days: number): { year: number; month: number; day: number } {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
	return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

function dayOfWeekZh(name: string): Weekday | null {
	const idx = WEEKDAY_NAMES_ZH.indexOf(name);
	return idx >= 0 ? (idx as Weekday) : null;
}

function dayOfWeekEn(name: string): Weekday | null {
	const idx = WEEKDAY_NAMES_EN.indexOf(name.toLowerCase());
	return idx >= 0 ? (idx as Weekday) : null;
}

/**
 * Deterministic, LLM-free detector. Returns null if no obvious schedule
 * pattern matches. Designed for low-latency frontend use.
 */
export class DeterministicPatternDetector implements ScheduleIntentDetector {
	detect(text: string, now: Date = new Date()): DetectedScheduleIntent | null {
		const t = text.trim();
		if (!t) return null;

		// 1. "X 分钟后提醒我 ..." / "in X minutes, ..."
		const m1 = /(\d{1,4})\s*(分钟|分|minutes?|mins?)\s*(后|later)?\s*(.*)$/i.exec(t);
		if (m1) {
			const n = Number(m1[1]);
			if (n >= 1 && n <= 24 * 60 * 7) {
				const prompt = pickPrompt(m1[4], "");
				if (prompt) {
					return {
						schedule: {
							mode: "every_n_minutes",
							everyN: { n, unit: "minute" },
							startAt: now.getTime(),
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}

		// 2. "X 小时后提醒我 ..." / "in X hours, ..."
		const m2 = /(\d{1,4})\s*(小时|hours?|hrs?)\s*(后|later)?\s*(.*)$/i.exec(t);
		if (m2) {
			const n = Number(m2[1]);
			if (n >= 1 && n <= 24 * 30) {
				const prompt = pickPrompt(m2[4], "");
				if (prompt) {
					return {
						schedule: {
							mode: "every_n_hours",
							everyN: { n, unit: "hour" },
							startAt: now.getTime(),
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}

		// 3. Absolute time within today/tomorrow/etc.: "<day> HH:MM <prompt>"
		// Examples: "tomorrow 8:00 remind me ..." / "明天 8:00 提醒我 ...",
		// "today 14:30 ...", "tomorrow at 9:00 ..."
		const dayMatch = /(今天|明天|后天|今日|明日|后日|today|tomorrow|tonight)\s*(at\s+)?(\d{1,2}:\d{2})\s+(.*)$/i.exec(t);
		if (dayMatch) {
			const dayWord = dayMatch[1]!.toLowerCase();
			const timeStr = dayMatch[3]!;
			const after = dayMatch[4];
			const tod = parseTimeOfDay(timeStr);
			if (tod) {
				const offset = dayWord.startsWith("tomorrow") || dayWord === "明天" || dayWord === "明日" ? 1
					: dayWord.startsWith("今天") || dayWord === "today" || dayWord === "今日" || dayWord === "tonight" ? 0
					: 2; // 后天 / 后日 (day after tomorrow)
				const target = tomorrow(now, offset);
				const fireAt = new Date(target.year, target.month, target.day, tod.hour, tod.minute, 0, 0).getTime();
				const prompt = pickPrompt(after, "");
				if (prompt && fireAt > now.getTime()) {
					// We model "tomorrow HH:MM" / "明天 HH:MM" as a one-shot (cron is
					// too noisy). Since the engine supports endAt + startAt with
					// arbitrary schedule, we use the simpler cron form for
					// reusability: `M H * * *`.
					return {
						schedule: {
							mode: "daily",
							times: [tod],
							startAt: fireAt,
							endAt: fireAt + 60_000,
						},
						prompt,
						confidence: 0.9,
					};
				}
			}
		}

		// 4. "每天 HH:MM ..." / "every day at HH:MM ..."
		const m3 = /(每天|每日|every\s*day|daily)\s*(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/i.exec(t);
		if (m3) {
			const tod = parseTimeOfDay(m3[3]!);
			if (tod) {
				const prompt = pickPrompt(m3[4], "");
				if (prompt) {
					return {
						schedule: { mode: "daily", times: [tod] },
						prompt,
						confidence: 0.95,
					};
				}
			}
		}

		// 5. "工作日 HH:MM ..." / "weekdays at HH:MM ..." / "Mon-Fri HH:MM ..."
		const m4 = /(工作日|每个工作日|weekdays|mon-fri|monday\s*to\s*friday)\s*(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/i.exec(t);
		if (m4) {
			const tod = parseTimeOfDay(m4[3]!);
			if (tod) {
				const prompt = pickPrompt(m4[4], "");
				if (prompt) {
					return {
						schedule: {
							mode: "weekdays",
							times: [tod],
							weekdays: [1, 2, 3, 4, 5],
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}

		// 6. "每周X HH:MM ..." / "every Monday HH:MM ..."
		//    Accept both 周一/周二/.../周日 (zh: Mon/Tue/.../Sun) and
		//    monday/tuesday/.../sunday (en).
		const m5 = /每(周|星期)([日一二三四五六天])\s*(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/.exec(t);
		if (m5) {
			const tod = parseTimeOfDay(m5[4]!);
			const wd = dayOfWeekZh(`周${m5[2]}`);
			if (tod && wd !== null) {
				const prompt = pickPrompt(m5[5], "");
				if (prompt) {
					return {
						schedule: {
							mode: "weekly",
							times: [tod],
							weekdays: [wd],
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}
		const m5en = /every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/i.exec(t);
		if (m5en) {
			const tod = parseTimeOfDay(m5en[3]!);
			const wd = dayOfWeekEn(m5en[1]!);
			if (tod && wd !== null) {
				const prompt = pickPrompt(m5en[4], "");
				if (prompt) {
					return {
						schedule: {
							mode: "weekly",
							times: [tod],
							weekdays: [wd],
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}

		// 7. "每月 X 号 HH:MM ..." / "on the 15th of every month ..."
		const m6 = /每月\s*(\d{1,2})\s*(日|号)\s*(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/.exec(t);
		if (m6) {
			const day = Number(m6[1]);
			const tod = parseTimeOfDay(m6[4]!);
			if (tod && day >= 1 && day <= 31) {
				const prompt = pickPrompt(m6[5], "");
				if (prompt) {
					return {
						schedule: {
							mode: "monthly",
							times: [tod],
							daysOfMonth: [day],
						},
						prompt,
						confidence: 0.95,
					};
				}
			}
		}
		const m6en = /on\s+the\s+(\d{1,2})(st|nd|rd|th)?\s*(of\s+every\s+month\s+)?(at\s+)?(\d{1,2}:\d{2})\s*(.*)$/i.exec(t);
		if (m6en) {
			const day = Number(m6en[1]);
			const tod = parseTimeOfDay(m6en[5]!);
			if (tod && day >= 1 && day <= 31) {
				const prompt = pickPrompt(m6en[6], "");
				if (prompt) {
					return {
						schedule: {
							mode: "monthly",
							times: [tod],
							daysOfMonth: [day],
						},
						prompt,
						confidence: 0.9,
					};
				}
			}
		}

		return null;
	}
}

const defaultDetector = new DeterministicPatternDetector();

/** Convenience wrapper using the default detector. */
export function detectScheduleIntent(text: string, now?: Date): DetectedScheduleIntent | null {
	return defaultDetector.detect(text, now);
}