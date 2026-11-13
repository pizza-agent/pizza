import { createHash } from "crypto";

/**
 * Anchor format: `<line>#<fingerprint>` where fingerprint is a 4-hex
 * prefix of sha256(structuralForm(lineText)). The line number is a
 * proximity HINT, not a hard constraint — edits routinely shift lines, so
 * resolution first tries the hinted position, then falls back to a
 * fingerprint match anywhere in the file, preferring the candidate nearest
 * the hint.
 *
 * The fingerprint is STRUCTURAL: computed over the trimmed line with
 * interior whitespace runs collapsed to one space. That keeps an anchor
 * stable across the two most common kinds of drift — re-indentation and
 * trailing-whitespace churn — while still distinguishing real content.
 * Exact indentation is deliberately NOT part of the fingerprint: edit ops
 * replace or delete whole lines, so matching on shape + position is both
 * sufficient and far more forgiving. The line-number hint disambiguates
 * duplicate lines (}, import, blanks) that share a fingerprint.
 *
 * Parser accepts 2–8 hex digits so anchors emitted by older builds still
 * parse; a fingerprint from an old exact-text build simply won't match and
 * the edit reports stale — same recovery path as any drift.
 */
const HASH_LENGTH = 4;
const LINE_ANCHOR_PATTERN = /^([1-9]\d*)#([0-9a-f]{2,8})$/;

/** Structural fingerprint of a line: whitespace-insensitive, stable under re-indentation. */
export function hashLine(line: string): string {
	return createHash("sha256").update(line.trim().replace(/\s+/g, " "), "utf-8").digest("hex").slice(0, HASH_LENGTH);
}

export interface LineAnchor {
	line: number;
	hash: string;
}

export interface RangeAnchor {
	start: LineAnchor;
	end: LineAnchor;
}

export interface LineRecord {
	lineNumber: number;
	text: string;
	startIndex: number;
	contentEndIndex: number;
	replacementEndIndex: number;
	hash: string;
}

export interface ResolvedLineRange {
	range: string;
	startLine: number;
	endLine: number;
	startIndex: number;
	endIndex: number;
	existingText: string;
	/** True when the anchor resolved away from its hinted position. */
	usedRelocation: boolean;
}

export function formatLineAnchor(lineNumber: number, line: string): string {
	return `${lineNumber}#${hashLine(line)}`;
}

export function formatRange(start: LineAnchor, end: LineAnchor = start): string {
	const startId = `${start.line}#${start.hash}`;
	const endId = `${end.line}#${end.hash}`;
	return startId === endId ? startId : `${startId}..${endId}`;
}

export function looksLikeRange(value: string): boolean {
	try {
		parseRange(value);
		return true;
	} catch {
		return false;
	}
}

export function parseRange(range: string): RangeAnchor {
	const trimmed = range.trim();
	if (!trimmed) {
		throw new Error("range must not be empty.");
	}
	const parts = trimmed.split("..");
	if (parts.length > 2) {
		throw new Error(`Invalid range "${range}". Expected <line>#<hash> or <start>#<hash>..<end>#<hash>.`);
	}
	const start = parseLineAnchor(parts[0], range);
	const end = parseLineAnchor(parts[1] ?? parts[0], range);
	if (start.line > end.line) {
		throw new Error(`Invalid range "${range}". Start line must be before or equal to end line.`);
	}
	return { start, end };
}

export function buildLineRecords(content: string): LineRecord[] {
	if (content.length === 0) {
		return [
			{
				lineNumber: 1,
				text: "",
				startIndex: 0,
				contentEndIndex: 0,
				replacementEndIndex: 0,
				hash: hashLine(""),
			},
		];
	}

	const records: LineRecord[] = [];
	let startIndex = 0;
	let lineNumber = 1;
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== "\n") continue;
		const text = content.slice(startIndex, i);
		records.push({
			lineNumber,
			text,
			startIndex,
			contentEndIndex: i,
			replacementEndIndex: i + 1,
			hash: hashLine(text),
		});
		startIndex = i + 1;
		lineNumber++;
	}

	if (startIndex < content.length) {
		const text = content.slice(startIndex);
		records.push({
			lineNumber,
			text,
			startIndex,
			contentEndIndex: content.length,
			replacementEndIndex: content.length,
			hash: hashLine(text),
		});
	}

	return records;
}

export function annotateTextWithLineAnchors(text: string, startLine = 1): string {
	if (text.length === 0) {
		return "";
	}
	const lines = text.split("\n");
	if (text.endsWith("\n")) {
		lines.pop();
	}
	return lines.map((line, index) => `${formatLineAnchor(startLine + index, line)} | ${line}`).join("\n");
}

type Candidate = {
	startIndex: number;
	endIndex: number;
};

/**
 * Resolve an anchor to a concrete line range.
 *
 *   1. Fingerprint match at the hinted position (fast path, no relocation).
 *   2. Fingerprint match anywhere — the candidate nearest the hint wins
 *      (relocation); an equidistant tie is a real ambiguity and errors with
 *      a candidate list that includes line content snippets.
 */
export function resolveRange(content: string, range: string, path: string): ResolvedLineRange {
	const anchor = parseRange(range);
	const records = buildLineRecords(content);
	const length = anchor.end.line - anchor.start.line + 1;

	const direct = resolveByRecordIndex(records, anchor.start.line - 1, length, anchor);
	if (direct) {
		return buildResolvedRange(content, range, records, direct.startIndex, direct.endIndex, false);
	}

	const candidates = collectCandidates(records, length, anchor);
	// A hint beyond EOF means the anchor came from a different version of the
	// file entirely; guessing among duplicates is unsafe, so report ambiguity.
	if (anchor.start.line > records.length && candidates.length > 1) {
		throw ambiguityError(range, path, records, candidates);
	}
	const picked = pickNearest(records, candidates, anchor.start.line);
	if (picked) {
		return buildResolvedRange(content, range, records, picked.startIndex, picked.endIndex, true);
	}
	if (candidates.length > 1) {
		throw ambiguityError(range, path, records, candidates);
	}

	throw new Error(`range ${range} is stale in ${path}. Re-read the file and use current line anchors.`);
}

function collectCandidates(records: LineRecord[], length: number, anchor: RangeAnchor): Candidate[] {
	const candidates: Candidate[] = [];
	for (let i = 0; i <= records.length - length; i++) {
		const start = records[i];
		const end = records[i + length - 1];
		if (start.hash.startsWith(anchor.start.hash) && end.hash.startsWith(anchor.end.hash)) {
			candidates.push({ startIndex: i, endIndex: i + length - 1 });
		}
	}
	return candidates;
}

/**
 * Nearest candidate to the hint wins. A strictly-nearest candidate resolves
 * even when several lines share the fingerprint — duplicates like `}` or
 * repeated imports are the common case, and the hint is almost always right.
 * An exact distance tie returns undefined so the caller can report ambiguity
 * rather than guess.
 */
function pickNearest(records: LineRecord[], candidates: Candidate[], hintLine: number): Candidate | undefined {
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	let best: Candidate | undefined;
	let bestDist = Infinity;
	let tied = false;
	for (const candidate of candidates) {
		const dist = Math.abs(records[candidate.startIndex].lineNumber - hintLine);
		if (dist < bestDist) {
			best = candidate;
			bestDist = dist;
			tied = false;
		} else if (dist === bestDist) {
			tied = true;
		}
	}
	return tied ? undefined : best;
}

function ambiguityError(
	range: string,
	path: string,
	records: LineRecord[],
	candidates: Candidate[],
): Error {
	const detail =
		candidates
			.slice(0, 6)
			.map((c) => {
				const line = records[c.startIndex];
				const trimmed = line.text.trim();
				const snippet = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
				return `${line.lineNumber}#${line.hash} "${snippet}"`;
			})
			.join("; ") + (candidates.length > 6 ? "; …" : "");
	return new Error(
		`range ${range} is ambiguous in ${path}: the hash matches ${candidates.length} equidistant locations (${detail}). ` +
			"Re-read around the intended line and use its current line-numbered anchor.",
	);
}

function parseLineAnchor(value: string | undefined, originalRange: string): LineAnchor {
	const match = value?.match(LINE_ANCHOR_PATTERN);
	if (!match) {
		throw new Error(
			`Invalid range "${originalRange}". Expected <line>#<hash> or <start>#<hash>..<end>#<hash>.`,
		);
	}
	return {
		line: Number(match[1]),
		hash: match[2],
	};
}

function resolveByRecordIndex(
	records: LineRecord[],
	startIndex: number,
	length: number,
	anchor: RangeAnchor,
): { startIndex: number; endIndex: number } | undefined {
	if (startIndex < 0) return undefined;
	const endIndex = startIndex + length - 1;
	if (endIndex >= records.length) return undefined;
	const start = records[startIndex];
	const end = records[endIndex];
	if (!start.hash.startsWith(anchor.start.hash) || !end.hash.startsWith(anchor.end.hash)) return undefined;
	return { startIndex, endIndex };
}

function buildResolvedRange(
	content: string,
	range: string,
	records: LineRecord[],
	startRecordIndex: number,
	endRecordIndex: number,
	usedRelocation: boolean,
): ResolvedLineRange {
	const start = records[startRecordIndex];
	const end = records[endRecordIndex];
	return {
		range,
		startLine: start.lineNumber,
		endLine: end.lineNumber,
		startIndex: start.startIndex,
		endIndex: end.replacementEndIndex,
		existingText: content.slice(start.startIndex, end.replacementEndIndex),
		usedRelocation,
	};
}