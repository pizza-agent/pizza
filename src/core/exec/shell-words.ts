/**
 * POSIX-aware shell word splitter shared by builtin command parsing and the
 * intent classifier.
 *
 * Quoting semantics (POSIX shell):
 *   - single quotes: every character is literal; backslash never escapes
 *   - double quotes: backslash is special only before $ ` " \ and newline;
 *     before any other char the backslash itself is kept literally
 *   - unquoted: a backslash escapes the next character (a trailing backslash
 *     is kept literally)
 *
 * Whitespace outside quotes separates words. An empty quoted region (`''` or
 * `""`) yields a single empty-string word, matching POSIX shells — e.g.
 * `a "" b` splits into ["a", "", "b"].
 */

export interface SplitShellWordsMeta {
	/**
	 * Number of quote *delimiter* characters the splitter consumed as quoting
	 * (i.e. a " or ' that opened/closed a quoted region), as opposed to a
	 * literal quote kept in the output. When a positional command argument is
	 * reconstructed by joining several words AND quote delimiters were consumed,
	 * the caller almost certainly meant the quote characters literally (e.g.
	 * `secret("X", "Y")`) but the splitter treated them as quoting and silently
	 * dropped them — that is the "quote stripping" corruption we detect.
	 */
	quoteDelimitersConsumed: number;
}

export function splitShellWords(input: string): string[] {
	return splitShellWordsWithMeta(input).words;
}

export function splitShellWordsWithMeta(input: string): { words: string[]; meta: SplitShellWordsMeta } {
	const words: string[] = [];
	let current = "";
	// Whether the current word has begun (saw any character, including an
	// opening quote delimiter). Distinct from `current.length > 0` so that an
	// empty quoted region ("") still counts as a word.
	let inWord = false;
	// Active quote context: undefined (unquoted), "'" (single), or '"' (double).
	let quote: "'" | '"' | undefined;
	let quoteDelimitersConsumed = 0;

	// Inside double quotes a backslash only escapes these characters; before
	// any other char the backslash itself is kept literally. (String.fromCharCode
	// is used for the newline entry to avoid escape-sequence ambiguity.)
	const doubleEscapable = new Set(["$", "`", '"', "\\", String.fromCharCode(10)]);

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		if (quote === "'") {
			// Single quote: everything is literal until the closing quote.
			if (char === "'") {
				quote = undefined;
				quoteDelimitersConsumed++;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === '"') {
			// Double quote: backslash is special only before $ ` " \ and newline.
			if (char === "\\" && next !== undefined && doubleEscapable.has(next)) {
				current += next;
				i++;
			} else if (char === '"') {
				quote = undefined;
				quoteDelimitersConsumed++;
			} else {
				current += char;
			}
			continue;
		}

		// Unquoted.
		if (char === "\\") {
			if (next !== undefined) {
				current += next;
				i++;
			} else {
				// A trailing backslash is kept literally.
				current += "\\";
			}
			inWord = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			quoteDelimitersConsumed++;
			inWord = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (inWord) {
				words.push(current);
				current = "";
				inWord = false;
			}
			continue;
		}
		current += char;
		inWord = true;
	}

	// An unterminated quote keeps whatever was collected (best-effort); a
	// trailing backslash was already handled inside the loop.
	if (inWord) {
		words.push(current);
	}
	return { words, meta: { quoteDelimitersConsumed } };
}

// ============================================================================
// Shared quote-aware scanning (single source of truth for shell syntax checks)
// ============================================================================

/**
 * Compute a mask over `input` marking which characters are LIVE SHELL CODE —
 * i.e. not inside quotes and not consumed by an escape. Only characters with
 * mask[i] === 1 can act as shell operators.
 *
 * Uses the same POSIX quoting rules as splitShellWordsWithMeta above:
 *   - single quotes: everything literal (backslash never escapes);
 *   - double quotes: backslash special only before $ ` " \ and newline;
 *   - unquoted: backslash escapes the next character.
 *
 * All shell-syntax checks (control-operator detection, segment splitting)
 * MUST be built on this mask. Pizza previously had three hand-written
 * scanners with subtly different quoting rules; the divergence was a
 * classification-bypass risk (e.g. treating \' inside single quotes as an
 * escape made a real trailing operator look quoted).
 */
function computeUnquotedCodeMask(input: string): Uint8Array {
	const mask = new Uint8Array(input.length);
	const doubleEscapable = new Set(["$", "`", '"', "\\", String.fromCharCode(10)]);
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (char === "\\" && input[i + 1] !== undefined && doubleEscapable.has(input[i + 1])) {
				i++;
			} else if (char === '"') {
				quote = undefined;
			}
			continue;
		}
		if (char === "\\") {
			i++; // escapes the next character (trailing backslash escapes nothing)
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		mask[i] = 1;
	}
	return mask;
}

/**
 * True when `command` contains a shell control operator outside quotes:
 * | & ; < > or a newline. Used to decide that a built-in style command line
 * actually needs a real shell (built-ins never support operators).
 */
export function hasShellControlSyntax(command: string): boolean {
	const mask = computeUnquotedCodeMask(command);
	for (let i = 0; i < command.length; i++) {
		if (!mask[i]) continue;
		const c = command[i];
		if (c === "|" || c === "&" || c === ";" || c === "<" || c === ">" || c === "\n") return true;
	}
	return false;
}

/**
 * Split a command line into segments on unquoted chaining operators:
 * && || ; and | (single & — background — is NOT a separator). Operator
 * characters are not included in any segment. Segments preserve original
 * spelling (quotes/escapes intact) so they can be re-parsed with
 * splitShellWords.
 */
export function splitShellSegments(command: string): string[] {
	const mask = computeUnquotedCodeMask(command);
	const segments: string[] = [];
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		if (!mask[i]) continue;
		const c = command[i];
		const two = (c === "&" || c === "|") && command[i + 1] === c && mask[i + 1] === 1;
		if (two || c === ";" || c === "|") {
			segments.push(command.slice(start, i));
			start = i + (two ? 2 : 1);
			if (two) i++;
		}
	}
	segments.push(command.slice(start));
	return segments;
}
