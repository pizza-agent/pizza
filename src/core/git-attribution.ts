/**
 * Attribution for commits Pizza creates: every `git commit` the agent runs
 * gets a `Co-Authored-By: pizza-agent[bot] <...>` trailer, mirroring how
 * Cursor, Claude Code and Codex sign their commits.
 *
 * The trailer resolves to the `pizza-agent` GitHub App (App ID 5770952,
 * https://github.com/apps/pizza-agent): its bot user `pizza-agent[bot]`
 * (ID 356990035) owns the noreply address, so GitHub renders the co-author
 * as a clickable link with the app logo. App name/slug changes rotate the
 * slug — the bot user ID stays stable, keep it in the address.
 *
 * The trailer is injected deterministically as a shell spawn hook — NOT by
 * prompting the model — so it cannot be forgotten, hallucinated or dropped,
 * and no hook file is written into the user's repository. The system prompt
 * separately tells the model the trailer is automatic so it does not add a
 * duplicate by hand (git itself deduplicates identical trailers anyway).
 */

import { execSync } from "node:child_process";
import { computeUnquotedCodeMask, splitShellCommands, splitShellWords } from "./exec/shell-words.js";

/** `Co-Authored-By` identity written into commits Pizza authors. */
export const PIZZA_CO_AUTHOR = "pizza-agent[bot] <356990035+pizza-agent[bot]@users.noreply.github.com>";

/** Full trailer line appended to commit messages. */
export const PIZZA_CO_AUTHOR_TRAILER = `Co-Authored-By: ${PIZZA_CO_AUTHOR}`;

const MIN_TRAILER_GIT_VERSION: readonly [number, number] = [2, 32];

/** `git commit --trailer` exists since git 2.32. Cached per process. */
let trailerSupport: boolean | undefined;
export function gitSupportsCommitTrailer(): boolean {
	if (trailerSupport === undefined) {
		trailerSupport = false;
		try {
			const out = execSync("git --version", {
				encoding: "utf8",
				timeout: 3000,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			const match = out.match(/git version (\d+)\.(\d+)/);
			if (match) {
				const major = Number(match[1]);
				const minor = Number(match[2]);
				trailerSupport =
					major > MIN_TRAILER_GIT_VERSION[0] ||
					(major === MIN_TRAILER_GIT_VERSION[0] && minor >= MIN_TRAILER_GIT_VERSION[1]);
			}
		} catch {
			trailerSupport = false;
		}
	}
	return trailerSupport;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Locate `git` and `commit` in a word list. Handles env assignments
 * (FOO=bar git commit), `env`/`command` prefixes, and global git options
 * (-C, -c, --git-dir=..., --work-tree <x>, ...) between `git` and `commit`.
 * Returns the index of the `commit` word, or -1 when this is not a
 * recognizable `git commit` invocation (we bail rather than guess).
 */
function gitCommitWordIndex(words: string[]): number {
	let i = 0;
	while (i < words.length && ENV_ASSIGNMENT.test(words[i]!)) i++;
	if (i >= words.length) return -1;
	if (words[i] === "env") {
		i++;
		while (i < words.length) {
			const w = words[i]!;
			if (ENV_ASSIGNMENT.test(w)) {
				i++;
			} else if (w === "-i" || w === "-0" || w === "--null" || w === "--ignore-environment") {
				i++;
			} else if (w === "-u" || w === "--unset" || w === "-S" || w === "--split-string" || w === "-C" || w === "--chdir") {
				i += 2;
			} else if (w.startsWith("--unset=") || w.startsWith("--chdir=") || w.startsWith("--split-string=")) {
				i++;
			} else {
				break;
			}
		}
	} else if (words[i] === "command" || words[i] === "noglob") {
		i++;
	}
	if (words[i] !== "git") return -1;
	i++;

	// Global git options that consume a separate value word.
	const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	while (i < words.length) {
		const w = words[i]!;
		if (w === "commit") return i;
		if (gitValueOptions.has(w)) {
			i += 2;
			continue;
		}
		if (w.startsWith("--") && w.includes("=")) {
			i++;
			continue;
		}
		if (w.startsWith("-")) {
			i++;
			continue;
		}
		// First non-option word is the subcommand; it isn't commit.
		return -1;
	}
	return -1;
}

/**
 * Whether a segment containing `git commit` at `commitIndex` may safely take
 * an appended `--trailer` option. Conservative: bail on anything unusual
 * (the trailer is nice-to-have, never worth breaking a commit).
 */
function isAnnotatableCommit(words: string[], commitIndex: number, segment: string): boolean {
	// Appending after `--` would turn --trailer into a literal pathspec.
	// A `--` word before commit cannot happen (it isn't a git global option).
	if (words.slice(commitIndex + 1).includes("--")) return false;
	// --dry-run never creates a commit; leave the command untouched.
	if (words.slice(commitIndex + 1).includes("--dry-run")) return false;
	// The message already carries a co-author trailer (-m/-F/-C/--trailer) —
	// respect what the author wrote.
	if (/co-authored-by:/i.test(segment)) return false;
	// A segment ending in an unquoted redirect operator (>, <, >>) would
	// turn the appended --trailer into the redirect target.
	const tail = segment.trimEnd();
	const last = tail[tail.length - 1];
	if (last === ">" || last === "<") {
		const mask = computeUnquotedCodeMask(tail);
		if (mask[tail.length - 1]) return false;
	}
	return true;
}

/**
 * True when `piece` still has an unclosed unquoted `(`, i.e. it runs inside
 * a subshell or command substitution. Appending an option there would inject
 * inside the outer quoting context, so such commands are skipped.
 */
function hasUnclosedParen(piece: string): boolean {
	const mask = computeUnquotedCodeMask(piece);
	let depth = 0;
	for (let i = 0; i < piece.length; i++) {
		if (!mask[i]) continue;
		if (piece[i] === "(") depth++;
		else if (piece[i] === ")") depth = Math.max(0, depth - 1);
	}
	return depth > 0;
}

/**
 * True when the piece contains an unquoted `$(` command substitution. A
 * `git commit` inside it parses as env-assign + words, but the trailer
 * append point (end of piece) may sit OUTSIDE the substitution — producing
 * `x=$(git commit -m x) --trailer ...` which is broken. Quoted `$(` (e.g.
 * -m "$(date)") does not count and stays annotatable.
 */
function hasUnquotedDollarParen(piece: string): boolean {
	const mask = computeUnquotedCodeMask(piece);
	for (let i = 0; i + 1 < piece.length; i++) {
		if (mask[i] && mask[i + 1] && piece[i] === "$" && piece[i + 1] === "(") return true;
	}
	return false;
}

const TRAILING_SEPARATOR = /(&&|\|\||[;|&\n]|\s)+$/;

/**
 * Rewrite `command` so every top-level `git commit` gets
 * `--trailer 'Co-Authored-By: ...'` appended. Returns the command unchanged
 * when there is nothing to annotate or rewriting would be unsafe.
 */
export function annotateGitCommits(command: string): string {
	const pieces = splitShellCommands(command);
	let changed = false;
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i]!;
		// Piece ends inside $(...)/(...) — appending would inject into the
		// outer command, not this segment. Leave it for the prompt guideline.
		if (hasUnclosedParen(piece)) continue;
		// Piece contains a $( — the commit may live inside the substitution
		// while the append point is outside it.
		if (hasUnquotedDollarParen(piece)) continue;
		const body = piece.replace(TRAILING_SEPARATOR, "");
		const trailer = piece.slice(body.length);
		const words = splitShellWords(body);
		const commitIndex = gitCommitWordIndex(words);
		if (commitIndex < 0) continue;
		if (!isAnnotatableCommit(words, commitIndex, body)) continue;
		pieces[i] = `${body} --trailer '${PIZZA_CO_AUTHOR_TRAILER}'${trailer}`;
		changed = true;
	}
	return changed ? pieces.join("") : command;
}
