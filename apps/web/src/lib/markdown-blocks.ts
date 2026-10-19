/**
 * Split a markdown document into render-stable blocks so a streaming
 * message can memoize finished blocks and only re-parse the tail.
 *
 * A block boundary is a run of blank lines at fence depth 0. Boundaries are
 * append-stable: appending text can only ever change the LAST block or add
 * new ones — a blank line stays blank forever, and a "```" line can never
 * be retroactively captured by an earlier fence because opening fences are
 * recorded before it is seen. That property is what lets callers key blocks
 * by index and memoize them by content.
 *
 * Fence tracking follows the CommonMark rules that matter here:
 *  - up to 3 leading spaces (4+ is indented code, not a fence)
 *  - a run of 3+ backticks or tildes opens; a run of the SAME char with
 *    length >= the opener's closes
 * Blank lines inside a fence are content, not boundaries — which also makes
 * an unclosed (still-streaming) fence absorb the rest of the document into
 * the tail block, matching how a full-document parse would render it.
 *
 * Known approximation vs. a full parse (the same trade ChatGPT's block
 * renderer makes): lazy continuation across a blank line splits where a
 * whole-document parse wouldn't (a setext underline after a blank line, or
 * a footnote definition in a later block). These render slightly
 * differently but never wrongly.
 */

/** Line that starts a code fence: ≤3 spaces of indent, then 3+ ` or ~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK_RE = /^\s*$/;

export function splitBlocks(text: string): string[] {
	const lines = text.split("\n");
	const blocks: string[] = [];

	let fenceChar = "";
	let fenceLen = 0;
	let start = 0;

	const closeBlock = (end: number, resumeAt: number) => {
		const content = lines.slice(start, end).join("\n");
		if (content.length > 0) blocks.push(content);
		start = resumeAt;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const run = fence[1]!;
			if (fenceChar === "") {
				fenceChar = run[0]!;
				fenceLen = run.length;
			} else if (run[0] === fenceChar && run.length >= fenceLen) {
				fenceChar = "";
				fenceLen = 0;
			}
			continue;
		}
		if (fenceChar === "" && BLANK_RE.test(line)) {
			// Swallow the whole blank run into the boundary so neither side
			// of the split carries it.
			let j = i + 1;
			while (j < lines.length && BLANK_RE.test(lines[j]!)) j++;
			closeBlock(i, j);
			i = j - 1;
		}
	}
	closeBlock(lines.length, lines.length);
	return blocks;
}