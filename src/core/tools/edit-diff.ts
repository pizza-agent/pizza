/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveRange, type ResolvedLineRange } from "./line-anchors.js";
import { resolveToCwd } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export type Edit =
	| { op: "replace"; range: string; new: string }
	| { op: "insert_before"; range: string; new: string }
	| { op: "insert_after"; range: string; new: string }
	| { op: "delete"; range: string }
	| { op: "search"; old: string; new: string };

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	replacement: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	/** Ranges that resolved by relocation (line numbers shifted) rather than at
	 *  their anchored position, e.g. "415#f9 → line 435". Surfaced so a relocated
	 *  edit is never silent. */
	relocations: string[];
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`No changes made to ${path}. The edit produced identical content.`);
	}
	return new Error(`No changes made to ${path}. The edits produced identical content.`);
}

function normalizeReplacementText(newValue: string, existingText: string): string {
	const normalized = normalizeToLF(newValue);
	if (existingText.endsWith("\n") && normalized.length > 0 && !normalized.endsWith("\n")) {
		return `${normalized}\n`;
	}
	return normalized;
}

function normalizeInsertionText(newValue: string, op: "insert_before" | "insert_after", range: ResolvedLineRange): string {
	const normalized = normalizeToLF(newValue);
	if (normalized.length === 0) {
		return "";
	}
	const lineText = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
	if (op === "insert_after" && range.existingText.length > 0 && !range.existingText.endsWith("\n")) {
		return `\n${lineText}`;
	}
	return lineText;
}

/**
 * Apply one or more range edits to LF-normalized content.
 *
 * All edits are resolved against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.op === "search") {
			if (edit.old.trim().length === 0) {
				throw new Error(`edits[${i}].old must not be empty in ${path}.`);
			}
		} else if (edit.range.trim().length === 0) {
			throw new Error(`edits[${i}].range must not be empty in ${path}.`);
		}
	}

	const baseContent = normalizedContent;
	const matchedEdits: MatchedEdit[] = [];
	const relocations: string[] = [];
	const failures: string[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];

		// Search-and-replace: find the exact text in the file, no line anchors needed.
		if (edit.op === "search") {
			const searchText = normalizeToLF(edit.old);
			const firstMatch = baseContent.indexOf(searchText);
			if (firstMatch === -1) {
				failures.push(
					`edits[${i}].old text not found in ${path}. Make sure the search text matches the file exactly (including whitespace and indentation).`,
				);
				continue;
			}
			const secondMatch = baseContent.indexOf(searchText, firstMatch + 1);
			if (secondMatch !== -1) {
				failures.push(
					`edits[${i}].old text matches multiple locations in ${path}. Include more surrounding lines in the search text to make it unique.`,
				);
				continue;
			}
			const existingText = baseContent.slice(firstMatch, firstMatch + searchText.length);
			matchedEdits.push({
				editIndex: i,
				matchIndex: firstMatch,
				matchLength: searchText.length,
				replacement: normalizeReplacementText(edit.new, existingText),
			});
			continue;
		}

		let resolved: ResolvedLineRange;
		try {
			resolved = resolveRange(baseContent, edit.range, path);
		} catch (err) {
			// Collect instead of throwing so one call reports every bad anchor,
			// not just the first — the model can fix them all in a single retry.
			failures.push(`edits[${i}]: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (resolved.usedRelocation) {
			relocations.push(`${edit.range} → line ${resolved.startLine}`);
		}
		let matchIndex = resolved.startIndex;
		let matchLength = resolved.endIndex - resolved.startIndex;
		let replacement = "";

		switch (edit.op) {
			case "replace":
				replacement = normalizeReplacementText(edit.new, resolved.existingText);
				break;
			case "insert_before":
				matchLength = 0;
				replacement = normalizeInsertionText(edit.new, edit.op, resolved);
				break;
			case "insert_after":
				matchIndex = resolved.endIndex;
				matchLength = 0;
				replacement = normalizeInsertionText(edit.new, edit.op, resolved);
				break;
			case "delete":
				replacement = "";
				break;
			default:
				failures.push(`edits[${i}].op is invalid in ${path}.`);
				continue;
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex,
			matchLength,
			replacement,
		});
	}

	if (failures.length > 0) {
		throw new Error(failures.join("\n"));
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.replacement +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, edits.length);
	}

	return { baseContent, newContent, relocations };
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return { error: `File not found: ${path}` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before resolving line anchors.
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
