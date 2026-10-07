import { useEffect, useState } from "react";

/** Built-in palette modes. Custom themes resolve to one of these as their base. */
export type Theme = "light" | "dark";

export interface CustomTheme {
	/** Theme name — the selector id persisted in localStorage. */
	name: string;
	/** Display label for pickers. */
	label: string;
	mode: Theme;
	tokens: Record<string, string>;
}

const STORAGE_KEY = "pizza-theme";
const MODE_KEY = "pizza-theme-mode";
const CSS_KEY = "pizza-theme-css";
const STYLE_ID = "pizza-custom-theme";

import { isTauri } from "./utils";
import { listThemes } from "./transport";

let customThemes: CustomTheme[] = [];
let styleEl: HTMLStyleElement | null = null;

function hexToRgbTuple(hex: string): [number, number, number] | null {
	const m = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
	return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

async function syncWindowBackground(mode: Theme, bgHex?: string): Promise<void> {
	if (!isTauri()) return;
	try {
		const core = await import("@tauri-apps/api/core");
		// Defaults match index.css: light #ffffff, dark #181818.
		const fallback: [number, number, number] = mode === "dark" ? [24, 24, 24] : [255, 255, 255];
		const rgb = (bgHex && hexToRgbTuple(bgHex)) ?? fallback;
		await core.invoke("set_window_background", { r: rgb[0], g: rgb[1], b: rgb[2] });
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Custom theme CSS generation
// ---------------------------------------------------------------------------

/** Tokens that may appear in a theme's `tokens` map → emitted as `--key`. */
const TOKEN_KEY_RE = /^[a-z][a-z0-9-]*$/;
/** Block values that could break out of the style block or load resources. */
const TOKEN_VALUE_RE = /[{};<>]|url\s*\(|expression\s*\(|javascript:|@import/i;

/**
 * Core tokens auto-derive the @pxlkit `retro-*` palette so a theme only needs
 * a handful of keys. Explicit `retro-*` / `color-retro-*` tokens win.
 */
const RETRO_DERIVATION: Record<string, string[]> = {
	bg: ["retro-bg"],
	surface: ["retro-surface", "retro-card"],
	fg: ["retro-text", "retro-primary"],
	border: ["retro-border", "retro-border-strong"],
	muted: ["retro-muted"],
	accent: ["retro-accent", "retro-cyan"],
	success: ["retro-green"],
	warning: ["retro-gold", "retro-secondary"],
	danger: ["retro-red"],
};

function sanitizeTokenKey(key: string): string | null {
	return TOKEN_KEY_RE.test(key) ? key : null;
}

function sanitizeTokenValue(value: string): string | null {
	const v = value.trim();
	return TOKEN_VALUE_RE.test(v) ? null : v;
}

/** Effective CSS vars for a theme: derived retro vars first, explicit tokens override. */
function resolveThemeVars(theme: CustomTheme): Record<string, string> {
	const vars: Record<string, string> = {};
	const explicit = new Set<string>();
	for (const key of Object.keys(theme.tokens)) {
		const k = sanitizeTokenKey(key);
		if (k) explicit.add(k);
	}
	for (const [key, raw] of Object.entries(theme.tokens)) {
		const k = sanitizeTokenKey(key);
		const v = sanitizeTokenValue(raw);
		if (!k || v === null) continue;
		vars[k] = v;
	}
	for (const [src, targets] of Object.entries(RETRO_DERIVATION)) {
		const value = vars[src];
		if (value === undefined) continue;
		for (const retro of targets) {
			if (!(retro in explicit)) {
				vars[retro] = value;
				vars[`color-${retro}`] = value;
			} else if (!(`color-${retro}` in explicit) && vars[retro] !== undefined) {
				vars[`color-${retro}`] = vars[retro];
			}
		}
	}
	return vars;
}

function renderThemeCss(theme: CustomTheme): string {
	const vars = resolveThemeVars(theme);
	const decls = Object.entries(vars)
		.map(([k, v]) => `--${k}:${v}`)
		.join(";");
	return `html[data-theme="${theme.name}"]{${decls}}`;
}

function ensureStyleEl(): HTMLStyleElement {
	if (styleEl && styleEl.isConnected) return styleEl;
	const existing = document.getElementById(STYLE_ID);
	styleEl = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
	styleEl.id = STYLE_ID;
	if (!styleEl.isConnected) document.head.appendChild(styleEl);
	return styleEl;
}

function injectThemesCss(): void {
	ensureStyleEl().textContent = customThemes.map(renderThemeCss).join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listCustomThemes(): CustomTheme[] {
	return customThemes;
}

/** Fetch the theme catalog from the agent and (re)generate the theme stylesheet. */
export async function refreshCustomThemes(): Promise<CustomTheme[]> {
	const infos = await listThemes();
	customThemes = infos
		.filter((t) => t.web && !t.builtin)
		.map((t) => ({
			name: t.name,
			label: t.web!.label ?? t.label ?? t.name,
			mode: t.web!.mode,
			tokens: t.web!.tokens,
		}));
	injectThemesCss();
	// Re-apply: a previously saved custom theme may have just become available.
	applyTheme(getThemeId());
	return customThemes;
}

function findCustomTheme(id: string): CustomTheme | undefined {
	return customThemes.find((t) => t.name === id);
}

function storedMode(id: string): Theme {
	try {
		const m = localStorage.getItem(MODE_KEY);
		if (m === "dark" || m === "light") return m;
	} catch {
		/* ignore */
	}
	return id === "light" ? "light" : "dark";
}

function applyTheme(id: string): void {
	const root = document.documentElement;
	const custom = findCustomTheme(id);
	const mode = custom ? custom.mode : id === "light" || id === "dark" ? id : storedMode(id);
	root.classList.toggle("dark", mode === "dark");
	if (custom) {
		root.dataset.theme = custom.name;
	} else {
		delete root.dataset.theme;
	}
	void syncWindowBackground(mode, custom?.tokens.bg);
}

export function getTheme(): Theme {
	if (typeof document === "undefined") return "light";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Current theme id: "light" | "dark" | a custom theme name. */
export function getThemeId(): string {
	if (typeof document === "undefined") return "light";
	return document.documentElement.dataset.theme ?? getTheme();
}

/** Select a theme: "light", "dark", or a custom theme name. */
export function setTheme(id: string): void {
	applyTheme(id);
	try {
		localStorage.setItem(STORAGE_KEY, id);
		localStorage.setItem(MODE_KEY, getTheme());
		const custom = findCustomTheme(id);
		if (custom) {
			localStorage.setItem(CSS_KEY, renderThemeCss(custom));
		} else {
			localStorage.removeItem(CSS_KEY);
		}
	} catch {
		/* ignore */
	}
}

export function toggleTheme(): Theme {
	const next: Theme = getTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

export function useTheme(): Theme {
	const [theme, setThemeState] = useState<Theme>(getTheme);
	useEffect(() => {
		const observer = new MutationObserver(() => setThemeState(getTheme()));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);
	// Sync window background on mount and theme change
	useEffect(() => {
		void syncWindowBackground(theme, findCustomTheme(getThemeId())?.tokens.bg);
	}, [theme]);
	return theme;
}

/** Reactive variant of getThemeId — re-renders when the theme id or mode changes. */
export function useThemeId(): string {
	const [id, setId] = useState<string>(getThemeId);
	useEffect(() => {
		const observer = new MutationObserver(() => setId(getThemeId()));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		return () => observer.disconnect();
	}, []);
	return id;
}
