import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { getCustomThemesDir, getThemesDir, isBunBinary } from "../../../src/config.js";
import type { SourceInfo } from "../../../src/core/skills/source-info.js";

// cli-highlight is only needed when code blocks are actually rendered — never
// at import time. Loading it here would tax every consumer of this module,
// including headless SDK sessions (resource-loader imports loadThemeFromPath).
// Under Node it is require()d lazily; in the compiled Bun binary require()
// cannot see bundled modules, so it is bundled via top-level await instead.
interface CliHighlight {
	highlight: (code: string, options?: Record<string, unknown>) => string;
	supportsLanguage: (name: string) => boolean;
}
let _cliHighlight: CliHighlight | undefined | null = isBunBinary
	? await import("cli-highlight")
			.then((m) => ((m as { default?: CliHighlight }).default ?? (m as unknown as CliHighlight)))
			.catch(() => null)
	: undefined;

function getCliHighlight(): CliHighlight | null {
	if (_cliHighlight === undefined) {
		try {
			_cliHighlight = createRequire(import.meta.url)("cli-highlight") as CliHighlight;
		} catch {
			_cliHighlight = null;
		}
	}
	return _cliHighlight;
}

// ============================================================================
// Types & Schema
// ============================================================================

// Theme JSON is validated by a small hand-rolled validator instead of TypeBox:
// identical constraints, zero dependency cost at import time, and no
// CJS-interop problems inside the compiled Bun binary.

/** hex "#ff0000", var ref "primary", 256-color index (0-255), or empty "" (terminal default) */
type ColorValue = string | number;

/** Upper bound for `web.splash.minDurationMs` — a theme must never hold the app hostage. */
export const MAX_SPLASH_MIN_DURATION_MS = 4000;

const THEME_COLOR_KEYS = [
	// Core UI
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText",
	// Backgrounds & Content Text
	"selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
	"toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
	// Markdown
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet",
	// Tool Diffs
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	// Syntax Highlighting
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
	"syntaxType", "syntaxOperator", "syntaxPunctuation",
	// Thinking Level Borders
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
	// Bash Mode
	"bashMode",
] as const;

interface ThemeJson {
	$schema?: string;
	name: string;
	vars?: Record<string, ColorValue>;
	colors: Record<string, ColorValue>;
	export?: {
		pageBg?: ColorValue;
		cardBg?: ColorValue;
		infoBg?: ColorValue;
	};
	web?: {
		label?: string;
		mode?: "light" | "dark";
		tokens?: Record<string, string>;
		title?: string;
		icon?: string;
		css?: string;
		video?: string;
		splash?: {
			css?: string;
			minDurationMs?: number;
		};
	};
}

function isColorValue(value: unknown): value is ColorValue {
	if (typeof value === "string") return true;
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Structural validation equivalent to the former TypeBox schema: required
 * color keys are reported separately (nicer "missing tokens" guidance),
 * everything else lands in the generic error list.
 */
function validateThemeJson(label: string, json: unknown): asserts json is ThemeJson {
	const missingColors: string[] = [];
	const otherErrors: string[] = [];
	const fail = (path: string, message: string) => otherErrors.push(`  - ${path}: ${message}`);

	const failRoot = () => {
		throw new Error(`Invalid theme "${label}":\n\nOther errors:\n  - : must be object`);
	};

	if (typeof json !== "object" || json === null || Array.isArray(json)) failRoot();
	const j = json as Record<string, unknown>;

	if (j.$schema !== undefined && typeof j.$schema !== "string") fail("/$schema", "must be string");
	if (typeof j.name !== "string") fail("/name", "must be string");

	if (j.vars !== undefined) {
		if (typeof j.vars !== "object" || j.vars === null || Array.isArray(j.vars)) {
			fail("/vars", "must be object");
		} else {
			for (const [key, value] of Object.entries(j.vars)) {
				if (!isColorValue(value)) fail(`/vars/${key}`, "must be string or 0-255 integer");
			}
		}
	}

	if (typeof j.colors !== "object" || j.colors === null || Array.isArray(j.colors)) {
		fail("/colors", "must be object");
		missingColors.push(...THEME_COLOR_KEYS);
	} else {
		const colors = j.colors as Record<string, unknown>;
		for (const key of THEME_COLOR_KEYS) {
			if (!(key in colors)) missingColors.push(key);
		}
		for (const [key, value] of Object.entries(colors)) {
			if (!isColorValue(value)) fail(`/colors/${key}`, "must be string or 0-255 integer");
		}
	}

	if (j.export !== undefined) {
		if (typeof j.export !== "object" || j.export === null || Array.isArray(j.export)) {
			fail("/export", "must be object");
		} else {
			for (const key of ["pageBg", "cardBg", "infoBg"] as const) {
				const value = (j.export as Record<string, unknown>)[key];
				if (value !== undefined && !isColorValue(value)) fail(`/export/${key}`, "must be string or 0-255 integer");
			}
		}
	}

	if (j.web !== undefined) {
		if (typeof j.web !== "object" || j.web === null || Array.isArray(j.web)) {
			fail("/web", "must be object");
		} else {
			const web = j.web as Record<string, unknown>;
			for (const key of ["label", "title", "icon", "css", "video"] as const) {
				if (web[key] !== undefined && typeof web[key] !== "string") fail(`/web/${key}`, "must be string");
			}
			if (web.mode !== undefined && web.mode !== "light" && web.mode !== "dark") {
				fail("/web/mode", 'must be "light" or "dark"');
			}
			if (web.tokens !== undefined) {
				if (typeof web.tokens !== "object" || web.tokens === null || Array.isArray(web.tokens)) {
					fail("/web/tokens", "must be object");
				} else {
					for (const [key, value] of Object.entries(web.tokens)) {
						if (typeof value !== "string") fail(`/web/tokens/${key}`, "must be string");
					}
				}
			}
			if (web.splash !== undefined) {
				if (typeof web.splash !== "object" || web.splash === null || Array.isArray(web.splash)) {
					fail("/web/splash", "must be object");
				} else {
					const splash = web.splash as Record<string, unknown>;
					if (splash.css !== undefined && typeof splash.css !== "string") fail("/web/splash/css", "must be string");
					if (
						splash.minDurationMs !== undefined &&
						(typeof splash.minDurationMs !== "number" ||
							splash.minDurationMs < 0 ||
							splash.minDurationMs > MAX_SPLASH_MIN_DURATION_MS)
					) {
						fail("/web/splash/minDurationMs", `must be number between 0 and ${MAX_SPLASH_MIN_DURATION_MS}`);
					}
				}
			}
		}
	}

	if (missingColors.length > 0 || otherErrors.length > 0) {
		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.length > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += missingColors.map((c) => `  - ${c}`).join("\n");
			errorMessage += "\n\nPlease add these colors to your theme's \"colors\" object.";
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}
		throw new Error(errorMessage);
	}
}

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ColorMode = "truecolor" | "256color";

/**
 * Web/desktop UI contribution resolved from a theme JSON: a light/dark mode
 * plus CSS custom-property tokens ("bg" → "--bg"). Derived automatically from
 * `colors` where a sensible mapping exists; an explicit `web.tokens` block
 * overrides derived entries.
 */
export interface WebThemeSpec {
	label?: string;
	mode: "light" | "dark";
	tokens: Record<string, string>;
	/** Window/document title and brand name shown while this theme is active. */
	title?: string;
	/**
	 * App icon (favicon, window icon, sidebar brand mark). A data: URI, or a
	 * file path resolved against the theme JSON's directory — resolved to a
	 * data URI by {@link resolveThemeIcon} before reaching clients.
	 */
	icon?: string;
	/** Raw CSS injected only while this theme is active (images, animations, ...). */
	css?: string;
	/**
	 * Background video (data: URI, or a file path resolved against the theme
	 * JSON's directory — resolved to a data URI by {@link resolveThemeVideo}
	 * before reaching clients). Rendered as a fixed layer behind app content;
	 * pair with translucent bg/surface tokens so it shows through.
	 */
	video?: string;
	/** Desktop launch-screen customization (see {@link WebThemeSplash}). */
	splash?: WebThemeSplash;
}

/**
 * Launch-screen contribution. The desktop splash exposes a stable DOM/CSS
 * contract (`.pizza-splash`, `.pizza-splash__backdrop|content|icon|message`,
 * `[data-state="active"|"exiting"]`, `html[data-pizza-phase="boot"|"ready"]`)
 * that `css` targets; that CSS is mounted only while the splash is on screen.
 */
export interface WebThemeSplash {
	/** Raw CSS mounted only while the launch screen is visible. */
	css?: string;
	/** Keep the splash up at least this long (ms, capped at {@link MAX_SPLASH_MIN_DURATION_MS}). */
	minDurationMs?: number;
}

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (process.env.WT_SESSION) {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	// Fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Terminal.app also doesn't support truecolor
	if (process.env.TERM_PROGRAM === "Apple_Terminal") {
		return "256color";
	}
	// GNU screen doesn't support truecolor unless explicitly opted in via COLORTERM=truecolor.
	// TERM under screen is typically "screen", "screen-256color", or "screen.xterm-256color".
	if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	readonly web?: WebThemeSpec;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo; web?: WebThemeSpec } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.web = options.web;
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
			case "max":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		const oceanPath = path.join(themesDir, "ocean.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(lightPath, "utf-8")) as ThemeJson,
			ocean: JSON.parse(fs.readFileSync(oceanPath, "utf-8")) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	if (fs.existsSync(customThemesDir)) {
		const files = fs.readdirSync(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	for (const name of registeredThemes.keys()) {
		themes.add(name);
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];

	// Built-in themes
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	if (fs.existsSync(customThemesDir)) {
		for (const file of fs.readdirSync(customThemesDir)) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some((t) => t.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	}

	for (const [name, theme] of registeredThemes.entries()) {
		if (!result.some((t) => t.name === name)) {
			result.push({ name, path: theme.sourcePath });
		}
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	validateThemeJson(label, json);
	return json;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

/**
 * TUI color keys that map cleanly onto web CSS custom properties. Themes
 * without an explicit `web` block still get a reasonable web presence from
 * this mapping; `web.tokens` entries override these.
 */
const TUI_TO_WEB_TOKENS: Record<string, string> = {
	accent: "accent",
	text: "fg",
	muted: "muted",
	border: "border",
	success: "success",
	warning: "warning",
	error: "danger",
	mdLink: "link",
	syntaxComment: "syn-comment",
	syntaxKeyword: "syn-keyword",
	syntaxFunction: "syn-func",
	syntaxVariable: "syn-var",
	syntaxString: "syn-string",
	syntaxNumber: "syn-number",
	syntaxType: "syn-type",
	syntaxPunctuation: "syn-punct",
};

/**
 * Resolve a web token value: var references resolve through `vars` (256-color
 * indices become hex), literal CSS values (hex, rgb(), ...) pass through.
 */
function resolveWebToken(value: string, vars: Record<string, ColorValue>): string | undefined {
	if (value === "") return undefined;
	if (value.startsWith("#") || !(value in vars)) return value;
	const resolved = resolveVarRefs(value, vars);
	if (resolved === "") return undefined;
	if (typeof resolved === "number") return ansi256ToHex(resolved);
	return resolved;
}

function buildWebSpec(themeJson: ThemeJson, resolvedColors: Record<string, string | number>): WebThemeSpec | undefined {
	const vars = themeJson.vars ?? {};
	const tokens: Record<string, string> = {};
	for (const [colorKey, token] of Object.entries(TUI_TO_WEB_TOKENS)) {
		const value = resolvedColors[colorKey];
		if (typeof value === "string" && value.startsWith("#")) {
			tokens[token] = value;
		} else if (typeof value === "number") {
			tokens[token] = ansi256ToHex(value);
		}
	}
	const explicit = themeJson.web?.tokens ?? {};
	for (const [key, value] of Object.entries(explicit)) {
		const resolved = resolveWebToken(value, vars);
		if (resolved !== undefined) tokens[key] = resolved;
	}
	if (!themeJson.web && Object.keys(tokens).length === 0) return undefined;
	const mode = themeJson.web?.mode ?? (/light/i.test(themeJson.name) ? "light" : "dark");
	return {
		label: themeJson.web?.label,
		mode,
		tokens,
		title: themeJson.web?.title,
		icon: themeJson.web?.icon,
		css: themeJson.web?.css,
		video: themeJson.web?.video,
		splash: themeJson.web?.splash,
	};
}

const ICON_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const VIDEO_MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};

/** Max media file sizes embedded into RPC payloads. */
const MAX_ICON_BYTES = 512 * 1024;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;

/**
 * Resolve a theme media reference to a data URI consumable by web/desktop
 * clients. `data:` URIs pass through; file paths resolve relative to the
 * theme JSON's directory (or absolute). Returns undefined when the media
 * cannot be resolved.
 */
function resolveThemeMedia(
	value: string | undefined,
	sourcePath: string | undefined,
	mimeTypes: Record<string, string>,
	maxBytes: number,
): string | undefined {
	if (!value || /^https?:\/\//i.test(value)) return undefined;
	if (value.startsWith("data:")) return value;
	const mediaPath = path.isAbsolute(value)
		? value
		: sourcePath
			? path.join(path.dirname(sourcePath), value)
			: undefined;
	if (!mediaPath) return undefined;
	const mime = mimeTypes[path.extname(mediaPath).toLowerCase()];
	if (!mime) return undefined;
	try {
		const stat = fs.statSync(mediaPath);
		if (!stat.isFile() || stat.size > maxBytes) return undefined;
		return `data:${mime};base64,${fs.readFileSync(mediaPath).toString("base64")}`;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a theme's `web.icon` to a data URI consumable by web/desktop
 * clients. `data:` URIs pass through; file paths resolve relative to the
 * theme JSON's directory (or absolute). Returns undefined when the icon
 * cannot be resolved to a data URI.
 */
export function resolveThemeIcon(icon: string | undefined, sourcePath: string | undefined): string | undefined {
	return resolveThemeMedia(icon, sourcePath, ICON_MIME_TYPES, MAX_ICON_BYTES);
}

/**
 * Resolve a theme's `web.video` to a data URI consumable by web/desktop
 * clients. Same resolution rules as {@link resolveThemeIcon}.
 */
export function resolveThemeVideo(video: string | undefined, sourcePath: string | undefined): string | undefined {
	return resolveThemeMedia(video, sourcePath, VIDEO_MIME_TYPES, MAX_VIDEO_BYTES);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
		web: buildWebSpec(themeJson, resolvedColors),
	});
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

/** Built-in themes that ship a `web` block (selectable in the desktop/web UI). */
export function getBuiltinWebThemes(): Theme[] {
	const themesDir = getThemesDir();
	return Object.entries(getBuiltinThemes())
		.filter(([, json]) => json.web)
		.map(([name]) => loadThemeFromPath(path.join(themesDir, `${name}.json`)));
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) {
				const result = bg < 8 ? "dark" : "light";
				return result;
			}
		}
	}
	return "dark";
}

function getDefaultTheme(): string {
	return detectTerminalBackground();
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("pizza:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
}

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // Can't watch a direct instance
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// Reload the theme from disk and refresh the registry cache
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
		}, 100);
	};

	try {
		themeWatcher = fs.watch(customThemesDir, (_eventType, filename) => {
			if (currentThemeName !== watchedThemeName) {
				return;
			}
			if (!filename) {
				scheduleReload();
				return;
			}
			const changedFile = String(filename);
			if (changedFile !== watchedFileName) {
				return;
			}
			scheduleReload();
		});
		themeWatcher.on("error", () => {
			try {
				themeWatcher?.close();
			} catch {
				/* ignore */
			}
			themeWatcher = undefined;
		});
	} catch (_error) {
		// Ignore errors starting watcher
	}
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
/**
 * Shared highlight implementation for highlightCode() and the markdown theme.
 * Falls back to mdCodeBlock-styled lines when cli-highlight is unavailable
 * (e.g. require() inside the compiled Bun binary resolving nothing).
 */
function highlightCodeImpl(code: string, lang: string | undefined): string[] {
	const hl = getCliHighlight();
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = hl && lang && hl.supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang || !hl) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return hl.highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

export function highlightCode(code: string, lang?: string): string[] {
	return highlightCodeImpl(code, lang);
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => highlightCodeImpl(code, lang),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): import("@earendil-works/pi-tui").SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
