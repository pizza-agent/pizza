import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { getToolPath } from "../../utils/tools-manager.js";

export interface CompatCommandContext {
	cwd: string;
}

export interface CompatCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

type CompatCommandName = "grep" | "find" | "ls";

export async function executeCompatCommand(
	command: string,
	args: string[],
	context: CompatCommandContext,
): Promise<CompatCommandResult> {
	switch (command) {
		case "grep":
			return executeCompatGrep(args, context);
		case "find":
			return executeCompatFind(args, context);
		case "ls":
			return executeCompatLs(args, context);
		default:
			return {
				stdout: "",
				stderr: `pizza: unsupported compat command: ${command}`,
				exitCode: 2,
			};
	}
}

export const COMPAT_COMMANDS: CompatCommandName[] = ["grep", "find", "ls"];

function appendLine(target: string[], line: string): void {
	target.push(line);
}

function result(
	stdoutLines: string[],
	stderrLines: string[],
	exitCode: number,
	stdoutSeparator: "\n" | "\0" = "\n",
): CompatCommandResult {
	return {
		stdout: stdoutLines.length > 0 ? `${stdoutLines.join(stdoutSeparator)}${stdoutSeparator}` : "",
		stderr: stderrLines.length > 0 ? `${stderrLines.join("\n")}\n` : "",
		exitCode,
	};
}

function parseInteger(command: string, flag: string, value: string | undefined): number | CompatCommandResult {
	if (value === undefined || value === "") {
		return {
			stdout: "",
			stderr: `${command}: option requires an argument -- ${flag}\n`,
			exitCode: 2,
		};
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
		return {
			stdout: "",
			stderr: `${command}: invalid number for ${flag}: ${value}\n`,
			exitCode: 2,
		};
	}
	return parsed;
}

function isCompatResult(value: unknown): value is CompatCommandResult {
	return !!value && typeof value === "object" && "exitCode" in value && "stdout" in value && "stderr" in value;
}

// ============================================================================
// grep
// ============================================================================

interface GrepOptions {
	patterns: string[];
	paths: string[];
	recursive: boolean;
	lineNumber: boolean;
	ignoreCase: boolean;
	fixedStrings: boolean;
	invertMatch: boolean;
	count: boolean;
	onlyMatching: boolean;
	wordRegexp: boolean;
	lineRegexp: boolean;
	withFilename?: boolean;
	noFilename?: boolean;
	noMessages: boolean;
	quiet: boolean;
	listFiles: boolean;
	filesWithoutMatch: boolean;
	maxCount?: number;
	beforeContext: number;
	afterContext: number;
	includeGlobs: string[];
	excludeGlobs: string[];
	excludeDirGlobs: string[];
}

function parseGrepArgs(args: string[]): GrepOptions | CompatCommandResult {
	const options: GrepOptions = {
		patterns: [],
		paths: [],
		recursive: false,
		lineNumber: false,
		ignoreCase: false,
		fixedStrings: false,
		invertMatch: false,
		count: false,
		onlyMatching: false,
		wordRegexp: false,
		lineRegexp: false,
		noMessages: false,
		quiet: false,
		listFiles: false,
		filesWithoutMatch: false,
		beforeContext: 0,
		afterContext: 0,
		includeGlobs: [],
		excludeGlobs: [],
		excludeDirGlobs: [],
	};

	let stopOptions = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (stopOptions) {
			if (options.patterns.length === 0) options.patterns.push(arg);
			else options.paths.push(arg);
			continue;
		}
		if (arg === "--") {
			stopOptions = true;
			continue;
		}
		if (arg === "--recursive" || arg === "--dereference-recursive") {
			options.recursive = true;
			continue;
		}
		if (arg === "--line-number") {
			options.lineNumber = true;
			continue;
		}
		if (arg === "--ignore-case") {
			options.ignoreCase = true;
			continue;
		}
		if (arg === "--fixed-strings") {
			options.fixedStrings = true;
			continue;
		}
		if (arg === "--invert-match") {
			options.invertMatch = true;
			continue;
		}
		if (arg === "--count") {
			options.count = true;
			continue;
		}
		if (arg === "--only-matching") {
			options.onlyMatching = true;
			continue;
		}
		if (arg === "--word-regexp") {
			options.wordRegexp = true;
			continue;
		}
		if (arg === "--line-regexp") {
			options.lineRegexp = true;
			continue;
		}
		if (arg === "--extended-regexp" || arg === "--basic-regexp") {
			continue;
		}
		if (arg === "--with-filename") {
			options.withFilename = true;
			continue;
		}
		if (arg === "--no-filename") {
			options.noFilename = true;
			continue;
		}
		if (arg === "--quiet" || arg === "--silent") {
			options.quiet = true;
			continue;
		}
		if (arg === "--no-messages") {
			options.noMessages = true;
			continue;
		}
		if (arg === "--files-with-matches") {
			options.listFiles = true;
			continue;
		}
		if (arg === "--files-without-match") {
			options.filesWithoutMatch = true;
			continue;
		}
		if (arg === "--include" || arg === "--exclude" || arg === "--exclude-dir") {
			const value = args[++i] ?? "";
			if (arg === "--include") options.includeGlobs.push(value);
			else if (arg === "--exclude") options.excludeGlobs.push(value);
			else options.excludeDirGlobs.push(value);
			continue;
		}
		if (arg.startsWith("--include=") || arg.startsWith("--exclude=") || arg.startsWith("--exclude-dir=")) {
			const [flag, rawValue] = arg.split("=", 2) as [string, string | undefined];
			const value = rawValue ?? "";
			if (flag === "--include") options.includeGlobs.push(value);
			else if (flag === "--exclude") options.excludeGlobs.push(value);
			else options.excludeDirGlobs.push(value);
			continue;
		}
		if (arg === "--color" || arg === "--colour" || arg.startsWith("--color=") || arg.startsWith("--colour=")) {
			continue;
		}
		if (arg === "--binary-files") {
			i++;
			continue;
		}
		if (arg.startsWith("--binary-files=")) {
			continue;
		}
		if (arg === "--regexp") {
			options.patterns.push(args[++i] ?? "");
			continue;
		}
		if (arg.startsWith("--regexp=")) {
			options.patterns.push(arg.slice("--regexp=".length));
			continue;
		}
		if (arg === "--max-count") {
			const parsed = parseInteger("grep", "--max-count", args[++i]);
			if (isCompatResult(parsed)) return parsed;
			options.maxCount = parsed;
			continue;
		}
		if (arg.startsWith("--max-count=")) {
			const parsed = parseInteger("grep", "--max-count", arg.slice("--max-count=".length));
			if (isCompatResult(parsed)) return parsed;
			options.maxCount = parsed;
			continue;
		}
		if (arg === "--context" || arg === "--after-context" || arg === "--before-context") {
			const parsed = parseInteger("grep", arg, args[++i]);
			if (isCompatResult(parsed)) return parsed;
			if (arg !== "--after-context") options.beforeContext = parsed;
			if (arg !== "--before-context") options.afterContext = parsed;
			continue;
		}
		if (arg.startsWith("--context=") || arg.startsWith("--after-context=") || arg.startsWith("--before-context=")) {
			const [flag, rawValue] = arg.split("=", 2) as [string, string | undefined];
			const parsed = parseInteger("grep", flag, rawValue);
			if (isCompatResult(parsed)) return parsed;
			if (flag !== "--after-context") options.beforeContext = parsed;
			if (flag !== "--before-context") options.afterContext = parsed;
			continue;
		}
		if (arg.startsWith("--")) {
			return {
				stdout: "",
				stderr: `grep: unsupported option: ${arg}\n`,
				exitCode: 2,
			};
		}
		if (arg.startsWith("-") && arg !== "-") {
			const parsed = parseGrepShortOptions(arg, args, i, options);
			if (isCompatResult(parsed)) return parsed;
			i = parsed;
			continue;
		}
		if (options.patterns.length === 0) options.patterns.push(arg);
		else options.paths.push(arg);
	}

	if (options.patterns.length === 0) {
		return {
			stdout: "",
			stderr: "grep: missing search pattern\n",
			exitCode: 2,
		};
	}

	return options;
}

function parseGrepShortOptions(
	arg: string,
	args: string[],
	index: number,
	options: GrepOptions,
): number | CompatCommandResult {
	const chars = arg.slice(1);
	for (let pos = 0; pos < chars.length; pos++) {
		const flag = chars[pos]!;
		const rest = chars.slice(pos + 1);
		switch (flag) {
			case "r":
			case "R":
				options.recursive = true;
				break;
			case "n":
				options.lineNumber = true;
				break;
			case "i":
				options.ignoreCase = true;
				break;
			case "F":
				options.fixedStrings = true;
				break;
			case "v":
				options.invertMatch = true;
				break;
			case "c":
				options.count = true;
				break;
			case "o":
				options.onlyMatching = true;
				break;
			case "w":
				options.wordRegexp = true;
				break;
			case "x":
				options.lineRegexp = true;
				break;
			case "E":
			case "G":
				break;
			case "H":
				options.withFilename = true;
				break;
			case "h":
				options.noFilename = true;
				break;
			case "q":
				options.quiet = true;
				break;
			case "s":
				options.noMessages = true;
				break;
			case "l":
				options.listFiles = true;
				break;
			case "L":
				options.filesWithoutMatch = true;
				break;
			case "I":
				break;
			case "e": {
				const value = rest || args[++index];
				if (value === undefined) {
					return { stdout: "", stderr: "grep: option requires an argument -- e\n", exitCode: 2 };
				}
				options.patterns.push(value);
				return index;
			}
			case "m": {
				const value = rest || args[++index];
				const parsed = parseInteger("grep", "-m", value);
				if (isCompatResult(parsed)) return parsed;
				options.maxCount = parsed;
				return index;
			}
			case "A":
			case "B":
			case "C": {
				const value = rest || args[++index];
				const parsed = parseInteger("grep", `-${flag}`, value);
				if (isCompatResult(parsed)) return parsed;
				if (flag !== "A") options.beforeContext = parsed;
				if (flag !== "B") options.afterContext = parsed;
				return index;
			}
			default:
				return { stdout: "", stderr: `grep: unsupported option -- ${flag}\n`, exitCode: 2 };
		}
	}
	return index;
}

async function executeCompatGrep(args: string[], context: CompatCommandContext): Promise<CompatCommandResult> {
	const parsed = parseGrepArgs(args);
	if (isCompatResult(parsed)) return parsed;
	if (parsed.recursive && parsed.paths.length === 0) parsed.paths.push(".");

	const rgResult = tryRunGrepWithRg(parsed, context);
	if (rgResult) return rgResult;

	return runGrepWithNode(parsed, context);
}

function tryRunGrepWithRg(options: GrepOptions, context: CompatCommandContext): CompatCommandResult | null {
	const rgPath = getToolPath("rg");
	if (!rgPath || options.paths.length === 0) return null;

	for (const inputPath of options.paths) {
		try {
			if (statSync(resolve(context.cwd, inputPath)).isDirectory() && !options.recursive) return null;
		} catch {
			return null;
		}
	}

	const rgArgs = ["--color=never", "--no-ignore", "--hidden"];
	if (options.lineNumber) rgArgs.push("--line-number");
	else rgArgs.push("--no-line-number");
	if (options.ignoreCase) rgArgs.push("--ignore-case");
	if (options.fixedStrings) rgArgs.push("--fixed-strings");
	if (options.invertMatch) rgArgs.push("--invert-match");
	if (options.count) rgArgs.push("--count");
	if (options.onlyMatching) rgArgs.push("--only-matching");
	if (options.wordRegexp) rgArgs.push("--word-regexp");
	if (options.lineRegexp) rgArgs.push("--line-regexp");
	if (options.quiet) rgArgs.push("--quiet");
	if (options.noMessages) rgArgs.push("--no-messages");
	if (options.listFiles) rgArgs.push("--files-with-matches");
	if (options.filesWithoutMatch) rgArgs.push("--files-without-match");
	if (options.withFilename) rgArgs.push("--with-filename");
	if (options.noFilename) rgArgs.push("--no-filename");
	if (options.maxCount !== undefined) rgArgs.push("--max-count", String(options.maxCount));
	if (options.beforeContext > 0) rgArgs.push("--before-context", String(options.beforeContext));
	if (options.afterContext > 0) rgArgs.push("--after-context", String(options.afterContext));
	for (const glob of options.includeGlobs) rgArgs.push("--glob", glob);
	for (const glob of options.excludeGlobs) rgArgs.push("--glob", `!${glob}`);
	for (const glob of options.excludeDirGlobs) rgArgs.push("--glob", `!${glob.replace(/\/$/, "")}/**`);
	for (const pattern of options.patterns) rgArgs.push("--regexp", pattern);
	rgArgs.push(...options.paths);

	const child = spawnSync(rgPath, rgArgs, { cwd: context.cwd, encoding: "utf-8", windowsHide: true });
	if (child.error) return null;
	return {
		stdout: child.stdout ?? "",
		stderr: child.stderr ?? "",
		exitCode: child.status ?? 2,
	};
}

async function runGrepWithNode(options: GrepOptions, context: CompatCommandContext): Promise<CompatCommandResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const matchers = buildGrepMatchers(options, stderr);
	if (!matchers) return result(stdout, stderr, 2);

	let matched = false;
	let hadError = false;

	const sources = await collectGrepSources(options, context, stderr);
	hadError ||= sources.hadError;

	for (const source of sources.items) {
		let fileMatched = false;
		let selectedLineCount = 0;
		let matchesForFile = 0;
		// Drop the trailing empty element produced by a final newline so it
		// is not counted as a line (matches GNU grep / ripgrep behavior).
		const rawLines = source.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
		const emitted = new Set<number>();

		for (let index = 0; index < lines.length; index++) {
			if (options.maxCount !== undefined && matchesForFile >= options.maxCount) break;
			const line = lines[index] ?? "";
			const rawMatch = matchesGrepLine(line, matchers, options);
			const selected = options.invertMatch ? !rawMatch : rawMatch;
			if (!selected) continue;
			matched = true;
			fileMatched = true;
			selectedLineCount++;
			matchesForFile++;
			if (options.quiet) continue;
			if (options.listFiles || options.filesWithoutMatch || options.count) continue;

			const start = Math.max(0, index - options.beforeContext);
			const end = Math.min(lines.length - 1, index + options.afterContext);
			for (let current = start; current <= end; current++) {
				if (emitted.has(current)) continue;
				emitted.add(current);
				const isMatch = current === index;
				if (isMatch && options.onlyMatching && !options.invertMatch) {
					for (const match of getGrepMatches(lines[current] ?? "", matchers, options)) {
						appendLine(stdout, formatGrepLine(source.displayName, current + 1, match, true, options, sources.forceFilename));
					}
				} else {
					appendLine(
						stdout,
						formatGrepLine(source.displayName, current + 1, lines[current] ?? "", isMatch, options, sources.forceFilename),
					);
				}
			}
		}

		if (options.quiet) {
			continue;
		}
		if (options.count) {
			appendLine(stdout, formatGrepLine(source.displayName, 0, String(selectedLineCount), true, { ...options, lineNumber: false }, sources.forceFilename));
		} else if (fileMatched && options.listFiles) {
			appendLine(stdout, source.displayName ?? "");
		} else if (!fileMatched && options.filesWithoutMatch) {
			matched = true;
			appendLine(stdout, source.displayName ?? "");
		}
	}

	return result(stdout, stderr, hadError ? 2 : matched ? 0 : 1);
}

type GrepMatcher =
	| { kind: "fixed"; pattern: string; comparePattern: string }
	| { kind: "regex"; regex: RegExp; globalRegex: RegExp };

function buildGrepMatchers(options: GrepOptions, stderr: string[]): GrepMatcher[] | null {
	if (options.fixedStrings) {
		return options.patterns.map((pattern) => ({
			kind: "fixed",
			pattern,
			comparePattern: options.ignoreCase ? pattern.toLowerCase() : pattern,
		}));
	}
	try {
		const flags = options.ignoreCase ? "i" : "";
		const globalFlags = options.ignoreCase ? "gi" : "g";
		return options.patterns.map((pattern) => {
			const wrapped = wrapGrepPattern(pattern, options);
			return {
				kind: "regex",
				regex: new RegExp(wrapped, flags),
				globalRegex: new RegExp(wrapped, globalFlags),
			};
		});
	} catch (error) {
		appendLine(stderr, `grep: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function wrapGrepPattern(pattern: string, options: GrepOptions): string {
	let wrapped = pattern;
	if (options.wordRegexp) wrapped = `\\b(?:${wrapped})\\b`;
	if (options.lineRegexp) wrapped = `^(?:${wrapped})$`;
	return wrapped;
}

function matchesGrepLine(line: string, matchers: GrepMatcher[], options: GrepOptions): boolean {
	return matchers.some((matcher) => {
		if (matcher.kind === "fixed") {
			return fixedPatternMatches(line, matcher, options);
		}
		matcher.regex.lastIndex = 0;
		return matcher.regex.test(line);
	});
}

function getGrepMatches(line: string, matchers: GrepMatcher[], options: GrepOptions): string[] {
	const matches: string[] = [];
	for (const matcher of matchers) {
		if (matcher.kind === "fixed") {
			matches.push(...getFixedMatches(line, matcher, options));
			continue;
		}
		matcher.globalRegex.lastIndex = 0;
		for (const match of line.matchAll(matcher.globalRegex)) {
			matches.push(match[0]);
			if (match[0] === "") break;
		}
	}
	return matches;
}

function fixedPatternMatches(line: string, matcher: Extract<GrepMatcher, { kind: "fixed" }>, options: GrepOptions): boolean {
	return getFixedMatches(line, matcher, options).length > 0;
}

function getFixedMatches(line: string, matcher: Extract<GrepMatcher, { kind: "fixed" }>, options: GrepOptions): string[] {
	const haystack = options.ignoreCase ? line.toLowerCase() : line;
	const pattern = matcher.comparePattern;
	const matches: string[] = [];
	if (pattern === "") return [""];
	let index = 0;
	while (index <= haystack.length) {
		const found = haystack.indexOf(pattern, index);
		if (found === -1) break;
		const end = found + pattern.length;
		if (
			(!options.wordRegexp || (isWordBoundary(line, found - 1) && isWordBoundary(line, end))) &&
			(!options.lineRegexp || (found === 0 && end === line.length))
		) {
			matches.push(line.slice(found, end));
		}
		index = Math.max(end, found + 1);
	}
	return matches;
}

function isWordBoundary(value: string, index: number): boolean {
	if (index < 0 || index >= value.length) return true;
	return !/[A-Za-z0-9_]/.test(value[index] ?? "");
}

async function collectGrepSources(
	options: GrepOptions,
	context: CompatCommandContext,
	stderr: string[],
): Promise<{ items: Array<{ displayName?: string; content: string }>; forceFilename: boolean; hadError: boolean }> {
	if (options.paths.length === 0) {
		return {
			items: [{ content: await readStdin() }],
			forceFilename: options.withFilename === true,
			hadError: false,
		};
	}

	const items: Array<{ displayName?: string; content: string }> = [];
	let hadError = false;
	for (const inputPath of options.paths) {
		const absolutePath = resolve(context.cwd, inputPath);
		let stats;
		try {
			stats = statSync(absolutePath);
		} catch {
			if (!options.noMessages) appendLine(stderr, `grep: ${inputPath}: No such file or directory`);
			hadError = true;
			continue;
		}
		if (stats.isDirectory()) {
			if (!options.recursive) {
				if (!options.noMessages) appendLine(stderr, `grep: ${inputPath}: Is a directory`);
				hadError = true;
				continue;
			}
			for (const filePath of walkFiles(absolutePath)) {
				const displayName = formatRecursiveDisplayName(inputPath, absolutePath, filePath);
				if (!shouldIncludeGrepFile(displayName, options)) continue;
				const content = readTextFile(filePath, stderr, "grep", displayName, options.noMessages);
				if (content === undefined) {
					hadError = true;
					continue;
				}
				items.push({ displayName, content });
			}
		} else {
			if (!shouldIncludeGrepFile(inputPath, options)) continue;
			const content = readTextFile(absolutePath, stderr, "grep", inputPath, options.noMessages);
			if (content === undefined) {
				hadError = true;
				continue;
			}
			items.push({ displayName: inputPath, content });
		}
	}

	const forceFilename =
		options.withFilename === true ||
		(!options.noFilename && (items.length > 1 || options.recursive || options.paths.length > 1));
	return { items, forceFilename, hadError };
}

function shouldIncludeGrepFile(displayName: string, options: GrepOptions): boolean {
	const normalized = displayName.replace(/^\.\//, "");
	const base = basename(normalized);
	if (options.includeGlobs.length > 0 && !options.includeGlobs.some((glob) => matchesPathOrBase(normalized, base, glob))) {
		return false;
	}
	if (options.excludeGlobs.some((glob) => matchesPathOrBase(normalized, base, glob))) {
		return false;
	}
	if (options.excludeDirGlobs.some((glob) => normalized.split("/").some((part) => minimatch(part, glob, { dot: true })))) {
		return false;
	}
	return true;
}

function matchesPathOrBase(pathValue: string, base: string, glob: string): boolean {
	return minimatch(pathValue, glob, { dot: true }) || minimatch(base, glob, { dot: true });
}

function formatRecursiveDisplayName(inputRoot: string, absoluteRoot: string, filePath: string): string {
	const relativePath = toPosix(relative(absoluteRoot, filePath));
	if (inputRoot === "." || inputRoot === "./") return `./${relativePath}`;
	return `${inputRoot.replace(/\/$/, "")}/${relativePath}`;
}

function formatGrepLine(
	displayName: string | undefined,
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: GrepOptions,
	forceFilename: boolean,
): string {
	const parts: string[] = [];
	const separator = isMatch ? ":" : "-";
	if (forceFilename && !options.noFilename && displayName) parts.push(displayName);
	if (options.lineNumber) parts.push(String(lineNumber));
	if (parts.length === 0) return line;
	return `${parts.join(separator)}${separator}${line}`;
}

// ============================================================================
// find
// ============================================================================

interface FindOptions {
	paths: string[];
	clauses: FindPredicate[][];
	maxDepth?: number;
	minDepth?: number;
	outputSeparator: "\n" | "\0";
}

type FindPredicate =
	| { kind: "name"; value: string; negate: boolean }
	| { kind: "iname"; value: string; negate: boolean }
	| { kind: "path"; value: string; negate: boolean }
	| { kind: "ipath"; value: string; negate: boolean }
	| { kind: "type"; value: "f" | "d" | "l"; negate: boolean }
	| { kind: "empty"; negate: boolean };

function parseFindArgs(args: string[]): FindOptions | CompatCommandResult {
	const options: FindOptions = { paths: [], clauses: [[]], outputSeparator: "\n" };
	let expressionStarted = false;
	let negateNext = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!expressionStarted && !arg.startsWith("-") && arg !== "(" && arg !== "!") {
			options.paths.push(arg);
			continue;
		}
		expressionStarted = true;
		switch (arg) {
			case "-name":
				addFindPredicate(options, { kind: "name", value: args[++i] ?? "", negate: negateNext });
				negateNext = false;
				break;
			case "-iname":
				addFindPredicate(options, { kind: "iname", value: args[++i] ?? "", negate: negateNext });
				negateNext = false;
				break;
			case "-path":
			case "-wholename":
				addFindPredicate(options, { kind: "path", value: args[++i] ?? "", negate: negateNext });
				negateNext = false;
				break;
			case "-ipath":
			case "-iwholename":
				addFindPredicate(options, { kind: "ipath", value: args[++i] ?? "", negate: negateNext });
				negateNext = false;
				break;
			case "-type": {
				const value = args[++i];
				if (value !== "f" && value !== "d" && value !== "l") {
					return { stdout: "", stderr: `find: unsupported -type value: ${value ?? ""}\n`, exitCode: 1 };
				}
				addFindPredicate(options, { kind: "type", value, negate: negateNext });
				negateNext = false;
				break;
			}
			case "-empty":
				addFindPredicate(options, { kind: "empty", negate: negateNext });
				negateNext = false;
				break;
			case "-maxdepth": {
				const parsed = parseInteger("find", "-maxdepth", args[++i]);
				if (isCompatResult(parsed)) return parsed;
				options.maxDepth = parsed;
				break;
			}
			case "-mindepth": {
				const parsed = parseInteger("find", "-mindepth", args[++i]);
				if (isCompatResult(parsed)) return parsed;
				options.minDepth = parsed;
				break;
			}
			case "!":
			case "-not":
				negateNext = !negateNext;
				break;
			case "-o":
			case "-or":
				options.clauses.push([]);
				negateNext = false;
				break;
			case "-print":
				options.outputSeparator = "\n";
				break;
			case "-print0":
				options.outputSeparator = "\0";
				break;
			case "-a":
			case "-and":
			case "(":
			case ")":
				break;
			default:
				return { stdout: "", stderr: `find: unsupported expression: ${arg}\n`, exitCode: 1 };
		}
	}

	if (options.paths.length === 0) options.paths.push(".");
	return options;
}

function addFindPredicate(options: FindOptions, predicate: FindPredicate): void {
	options.clauses[options.clauses.length - 1]?.push(predicate);
}

function executeCompatFind(args: string[], context: CompatCommandContext): CompatCommandResult {
	const parsed = parseFindArgs(args);
	if (isCompatResult(parsed)) return parsed;

	const fdResult = tryRunFindWithFd(parsed, context);
	if (fdResult) return fdResult;

	return runFindWithNode(parsed, context);
}

function tryRunFindWithFd(options: FindOptions, context: CompatCommandContext): CompatCommandResult | null {
	const fdPath = getToolPath("fd");
	if (!fdPath || options.outputSeparator !== "\n") return null;
	if (options.clauses.length !== 1) return null;
	const predicates = options.clauses[0] ?? [];
	const namePredicate = predicates.find(isPositiveFindNamePredicate);
	const typePredicate = predicates.find(isPositiveFindTypePredicate);
	const unsupported = predicates.some(
		(predicate) =>
			predicate.negate ||
			(predicate.kind !== "name" && predicate.kind !== "iname" && predicate.kind !== "type") ||
			((predicate.kind === "name" || predicate.kind === "iname") && predicate !== namePredicate) ||
			(predicate.kind === "type" && predicate !== typePredicate),
	);
	if (!namePredicate || unsupported) return null;

	const fdArgs = ["--hidden", "--no-ignore", "--color=never", "--glob"];
	if (namePredicate.kind === "iname") fdArgs.push("--ignore-case");
	if (options.maxDepth !== undefined) fdArgs.push("--max-depth", String(options.maxDepth));
	if (options.minDepth !== undefined) fdArgs.push("--min-depth", String(options.minDepth));
	if (typePredicate?.kind === "type" && typePredicate.value === "f") fdArgs.push("--type", "file");
	if (typePredicate?.kind === "type" && typePredicate.value === "d") fdArgs.push("--type", "directory");
	if (typePredicate?.kind === "type" && typePredicate.value === "l") fdArgs.push("--type", "symlink");
	fdArgs.push(namePredicate.value);
	for (const inputPath of options.paths) fdArgs.push(resolve(context.cwd, inputPath));

	const child = spawnSync(fdPath, fdArgs, { cwd: context.cwd, encoding: "utf-8", windowsHide: true });
	if (child.error || (child.status !== 0 && child.status !== 1)) return null;
	const lines = (child.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => normalizeFindEnginePath(line, options, context));
	return result(lines, child.stderr ? [child.stderr.trim()] : [], child.status ?? 0, options.outputSeparator);
}

function isPositiveFindNamePredicate(
	predicate: FindPredicate,
): predicate is Extract<FindPredicate, { kind: "name" | "iname" }> {
	return !predicate.negate && (predicate.kind === "name" || predicate.kind === "iname");
}

function isPositiveFindTypePredicate(predicate: FindPredicate): predicate is Extract<FindPredicate, { kind: "type" }> {
	return !predicate.negate && predicate.kind === "type";
}

function normalizeFindEnginePath(rawLine: string, options: FindOptions, context: CompatCommandContext): string {
	const absolutePath = isAbsolute(rawLine) ? rawLine : resolve(context.cwd, rawLine);
	for (const inputPath of options.paths) {
		const absoluteRoot = resolve(context.cwd, inputPath);
		const relativePath = relative(absoluteRoot, absolutePath);
		if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
			return formatFindDisplayName(inputPath, relativePath);
		}
	}
	return toPosix(relative(context.cwd, absolutePath));
}

function runFindWithNode(options: FindOptions, context: CompatCommandContext): CompatCommandResult {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let hadError = false;

	for (const inputPath of options.paths) {
		const absoluteRoot = resolve(context.cwd, inputPath);
		if (!existsSync(absoluteRoot)) {
			appendLine(stderr, `find: ${inputPath}: No such file or directory`);
			hadError = true;
			continue;
		}
		walkFind(inputPath, absoluteRoot, absoluteRoot, 0, options, stdout, stderr);
	}

	return result(stdout, stderr, hadError ? 1 : 0, options.outputSeparator);
}

function walkFind(
	inputRoot: string,
	absoluteRoot: string,
	currentPath: string,
	depth: number,
	options: FindOptions,
	stdout: string[],
	stderr: string[],
): void {
	const minDepth = options.minDepth ?? 0;
	const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
	let stats;
	try {
		stats = lstatSync(currentPath);
	} catch (error) {
		appendLine(stderr, `find: ${currentPath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const displayName = formatFindDisplayName(inputRoot, relative(absoluteRoot, currentPath));
	if (depth >= minDepth && depth <= maxDepth && matchesFindEntry(currentPath, displayName, stats, options)) {
		appendLine(stdout, displayName);
	}

	if (!stats.isDirectory() || depth >= maxDepth) return;

	let entries: string[];
	try {
		entries = readdirSync(currentPath).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		appendLine(stderr, `find: ${currentPath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	for (const entry of entries) {
		walkFind(inputRoot, absoluteRoot, join(currentPath, entry), depth + 1, options, stdout, stderr);
	}
}

function matchesFindEntry(path: string, displayName: string, stats: Stats, options: FindOptions): boolean {
	const activeClauses = options.clauses.length > 0 ? options.clauses : [[]];
	return activeClauses.some((clause) => clause.every((predicate) => matchesFindPredicate(path, displayName, stats, predicate)));
}

function matchesFindPredicate(path: string, displayName: string, stats: Stats, predicate: FindPredicate): boolean {
	let matched: boolean;
	const entryName = basename(path);
	switch (predicate.kind) {
		case "name":
			matched = minimatch(entryName, predicate.value, { dot: true });
			break;
		case "iname":
			matched = minimatch(entryName.toLowerCase(), predicate.value.toLowerCase(), { dot: true });
			break;
		case "path":
			matched = minimatch(displayName, predicate.value, { dot: true });
			break;
		case "ipath":
			matched = minimatch(displayName.toLowerCase(), predicate.value.toLowerCase(), { dot: true });
			break;
		case "type":
			matched =
				(predicate.value === "f" && stats.isFile()) ||
				(predicate.value === "d" && stats.isDirectory()) ||
				(predicate.value === "l" && stats.isSymbolicLink());
			break;
		case "empty":
			matched = isFindEntryEmpty(path, stats);
			break;
	}
	return predicate.negate ? !matched : matched;
}

function isFindEntryEmpty(path: string, stats: Stats): boolean {
	if (stats.isDirectory()) {
		try {
			return readdirSync(path).length === 0;
		} catch {
			return false;
		}
	}
	return stats.isFile() && stats.size === 0;
}

function formatFindDisplayName(inputRoot: string, relativePath: string): string {
	const normalized = toPosix(relativePath);
	if (!normalized) return inputRoot;
	if (inputRoot === "." || inputRoot === "./") return `./${normalized}`;
	return `${inputRoot.replace(/\/$/, "")}/${normalized}`;
}

// ============================================================================
// ls
// ============================================================================

interface LsOptions {
	all: boolean;
	almostAll: boolean;
	long: boolean;
	human: boolean;
	directory: boolean;
	onePerLine: boolean;
	recursive: boolean;
	reverse: boolean;
	sortBy: "name" | "time" | "size" | "none";
	classify: boolean;
	appendSlash: boolean;
	groupDirectoriesFirst: boolean;
	paths: string[];
}

function parseLsArgs(args: string[]): LsOptions | CompatCommandResult {
	const options: LsOptions = {
		all: false,
		almostAll: false,
		long: false,
		human: false,
		directory: false,
		onePerLine: false,
		recursive: false,
		reverse: false,
		sortBy: "name",
		classify: false,
		appendSlash: false,
		groupDirectoriesFirst: false,
		paths: [],
	};

	let stopOptions = false;
	for (const arg of args) {
		if (stopOptions) {
			options.paths.push(arg);
			continue;
		}
		if (arg === "--") {
			stopOptions = true;
			continue;
		}
		if (arg === "--all") {
			options.all = true;
			continue;
		}
		if (arg === "--almost-all") {
			options.almostAll = true;
			continue;
		}
		if (arg === "--long") {
			options.long = true;
			continue;
		}
		if (arg === "--human-readable") {
			options.human = true;
			continue;
		}
		if (arg === "--directory") {
			options.directory = true;
			continue;
		}
		if (arg === "--recursive") {
			options.recursive = true;
			continue;
		}
		if (arg === "--reverse") {
			options.reverse = true;
			continue;
		}
		if (arg === "--classify") {
			options.classify = true;
			continue;
		}
		if (arg === "--indicator-style=slash") {
			options.appendSlash = true;
			continue;
		}
		if (arg === "--group-directories-first") {
			options.groupDirectoriesFirst = true;
			continue;
		}
		if (arg === "--color" || arg.startsWith("--color=")) {
			continue;
		}
		if (arg.startsWith("--sort=")) {
			const sort = arg.slice("--sort=".length);
			if (sort === "time") options.sortBy = "time";
			else if (sort === "size") options.sortBy = "size";
			else if (sort === "none") options.sortBy = "none";
			else if (sort === "name" || sort === "extension" || sort === "version") options.sortBy = "name";
			else return { stdout: "", stderr: `ls: unsupported sort key: ${sort}\n`, exitCode: 2 };
			continue;
		}
		if (arg.startsWith("--")) {
			return { stdout: "", stderr: `ls: unsupported option: ${arg}\n`, exitCode: 2 };
		}
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of arg.slice(1)) {
				switch (flag) {
					case "a":
						options.all = true;
						break;
					case "A":
						options.almostAll = true;
						break;
					case "l":
						options.long = true;
						break;
					case "h":
						options.human = true;
						break;
					case "d":
						options.directory = true;
						break;
					case "1":
						options.onePerLine = true;
						break;
					case "R":
						options.recursive = true;
						break;
					case "r":
						options.reverse = true;
						break;
					case "t":
						options.sortBy = "time";
						break;
					case "S":
						options.sortBy = "size";
						break;
					case "f":
						options.all = true;
						options.sortBy = "none";
						break;
					case "F":
						options.classify = true;
						break;
					case "p":
						options.appendSlash = true;
						break;
					case "G":
					case "C":
					case "x":
					case "q":
						break;
					default:
						return { stdout: "", stderr: `ls: unsupported option -- ${flag}\n`, exitCode: 2 };
				}
			}
			continue;
		}
		options.paths.push(arg);
	}

	if (options.paths.length === 0) options.paths.push(".");
	return options;
}

function executeCompatLs(args: string[], context: CompatCommandContext): CompatCommandResult {
	const parsed = parseLsArgs(args);
	if (isCompatResult(parsed)) return parsed;

	const stdout: string[] = [];
	const stderr: string[] = [];
	let hadError = false;
	const multiplePaths = parsed.paths.length > 1;

	for (let pathIndex = 0; pathIndex < parsed.paths.length; pathIndex++) {
		const inputPath = parsed.paths[pathIndex]!;
		const absolutePath = resolve(context.cwd, inputPath);
		let stats;
		try {
			stats = statSync(absolutePath);
		} catch {
			appendLine(stderr, `ls: ${inputPath}: No such file or directory`);
			hadError = true;
			continue;
		}

		if (stats.isDirectory() && !parsed.directory) {
			if (multiplePaths || parsed.recursive) {
				if (stdout.length > 0) appendLine(stdout, "");
				appendLine(stdout, `${inputPath}:`);
			}
			emitLsDirectory(stdout, inputPath, absolutePath, parsed, multiplePaths || parsed.recursive);
		} else {
			appendLine(stdout, formatLsEntry(inputPath, absolutePath, parsed));
		}
	}

	return result(stdout, stderr, hadError ? 2 : 0);
}

function emitLsDirectory(
	stdout: string[],
	displayPath: string,
	absolutePath: string,
	options: LsOptions,
	includeRecursiveHeaders: boolean,
): void {
	const entries = listDirectoryEntries(absolutePath, options);
	for (const entry of entries) {
		const entryPath = join(absolutePath, entry);
		appendLine(stdout, formatLsEntry(entry, entryPath, options));
	}

	if (!options.recursive) return;

	for (const entry of entries) {
		if (entry === "." || entry === "..") continue;
		const entryPath = join(absolutePath, entry);
		let stats;
		try {
			stats = statSync(entryPath);
		} catch {
			continue;
		}
		if (!stats.isDirectory()) continue;
		const childDisplayPath = `${displayPath.replace(/\/$/, "")}/${entry}`;
		if (includeRecursiveHeaders) {
			appendLine(stdout, "");
			appendLine(stdout, `${childDisplayPath}:`);
		}
		emitLsDirectory(stdout, childDisplayPath, entryPath, options, includeRecursiveHeaders);
	}
}

function listDirectoryEntries(path: string, options: LsOptions): string[] {
	let entries = readdirSync(path);
	if (options.all) {
		entries = [".", "..", ...entries];
	} else if (!options.almostAll) {
		entries = entries.filter((entry) => !entry.startsWith("."));
	}
	return sortLsEntries(path, entries, options);
}

function sortLsEntries(path: string, entries: string[], options: LsOptions): string[] {
	if (options.sortBy === "none") return options.reverse ? entries.reverse() : entries;
	const sorted = [...entries].sort((a, b) => {
		const aPath = join(path, a);
		const bPath = join(path, b);
		const aStats = safeStat(aPath);
		const bStats = safeStat(bPath);
		if (options.groupDirectoriesFirst && aStats && bStats && aStats.isDirectory() !== bStats.isDirectory()) {
			return aStats.isDirectory() ? -1 : 1;
		}
		if (options.sortBy === "time" && aStats && bStats) {
			const diff = bStats.mtimeMs - aStats.mtimeMs;
			if (diff !== 0) return diff;
		}
		if (options.sortBy === "size" && aStats && bStats) {
			const diff = bStats.size - aStats.size;
			if (diff !== 0) return diff;
		}
		return a.localeCompare(b);
	});
	if (options.reverse) sorted.reverse();
	return sorted;
}

function safeStat(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function formatLsEntry(displayName: string, absolutePath: string, options: LsOptions): string {
	const name = formatLsDisplayName(displayName, absolutePath, options);
	if (!options.long) return name;
	const stats = statSync(absolutePath);
	const mode = formatMode(stats.mode, stats.isDirectory());
	const size = options.human ? humanSize(stats.size) : String(stats.size);
	const modified = stats.mtime.toISOString().slice(0, 16).replace("T", " ");
	return `${mode} ${String(stats.nlink).padStart(2, " ")} ${String(stats.uid).padStart(5, " ")} ${String(stats.gid).padStart(5, " ")} ${size.padStart(6, " ")} ${modified} ${name}`;
}

function formatLsDisplayName(displayName: string, absolutePath: string, options: LsOptions): string {
	let stats: Stats | undefined;
	let linkStats: Stats | undefined;
	try {
		stats = statSync(absolutePath);
		linkStats = lstatSync(absolutePath);
	} catch {
		return displayName;
	}
	if ((options.appendSlash || options.classify) && stats.isDirectory() && !displayName.endsWith("/")) {
		return `${displayName}/`;
	}
	if (options.classify) {
		if (linkStats.isSymbolicLink()) return `${displayName}@`;
		if (stats.mode & 0o111) return `${displayName}*`;
	}
	return displayName;
}

function formatMode(mode: number, directory: boolean): string {
	const chars = directory ? ["d"] : ["-"];
	const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
	for (let i = 0; i < masks.length; i++) {
		const bit = masks[i]!;
		const type = i % 3 === 0 ? "r" : i % 3 === 1 ? "w" : "x";
		chars.push(mode & bit ? type : "-");
	}
	return chars.join("");
}

function humanSize(size: number): string {
	const units = ["B", "K", "M", "G", "T"];
	let value = size;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	if (unitIndex === 0) return String(size);
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

// ============================================================================
// Shared helpers
// ============================================================================

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	return await new Promise<string>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString("utf-8"));
		};
		process.stdin.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		process.stdin.once("end", finish);
		process.stdin.once("error", finish);
		process.stdin.resume();
	});
}

function readTextFile(
	path: string,
	stderr: string[],
	command: string,
	displayName: string,
	suppressErrors = false,
): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch (error) {
		if (!suppressErrors) {
			appendLine(stderr, `${command}: ${displayName}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}
}

function walkFiles(root: string): string[] {
	const results: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) walk(fullPath);
			else if (entry.isFile()) results.push(fullPath);
		}
	};
	walk(root);
	return results;
}

function toPosix(value: string): string {
	return value.replace(/\\/g, "/");
}
