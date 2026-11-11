import { createHash } from "crypto";

const HASH_LENGTH = 2;
const LINE_ANCHOR_PATTERN = /^([1-9]\d*)#([0-9a-f]{2})$/;

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
	usedRelocation: boolean;
}

export function hashLine(line: string): string {
	return createHash("sha256").update(line, "utf-8").digest("hex").slice(0, HASH_LENGTH);
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

export function resolveRange(content: string, range: string, path: string): ResolvedLineRange {
	const anchor = parseRange(range);
	const records = buildLineRecords(content);
	const length = anchor.end.line - anchor.start.line + 1;

	const direct = resolveByRecordIndex(records, anchor.start.line - 1, length, anchor);
	if (direct) {
		return buildResolvedRange(content, range, records, direct.startIndex, direct.endIndex, false);
	}

	const candidates: Array<{ startIndex: number; endIndex: number }> = [];
	for (let i = 0; i <= records.length - length; i++) {
		const candidate = resolveByRecordIndex(records, i, length, anchor);
		if (candidate) {
			candidates.push(candidate);
		}
	}

	if (candidates.length === 1) {
		return buildResolvedRange(content, range, records, candidates[0].startIndex, candidates[0].endIndex, true);
	}

	if (candidates.length > 1) {
		const detail = candidates
			.slice(0, 6)
			.map((c) => `${records[c.startIndex].lineNumber}#${records[c.startIndex].hash}`)
			.join(", ") + (candidates.length > 6 ? ", …" : "");
		throw new Error(
			`range ${range} is ambiguous in ${path}: the hash matches ${candidates.length} locations (${detail}). ` +
				"Re-read around the intended line and use its current line-numbered anchor.",
		);
	}

	throw new Error(`range ${range} is stale in ${path}. Re-read the file and use current line anchors.`);
}

function parseLineAnchor(value: string | undefined, originalRange: string): LineAnchor {
	const match = value?.match(LINE_ANCHOR_PATTERN);
	if (!match) {
		throw new Error(
			`Invalid range "${originalRange}". Expected <line>#<2-hex-hash> or <start>#<hash>..<end>#<hash>.`,
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
	if (start.hash !== anchor.start.hash || end.hash !== anchor.end.hash) return undefined;
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
