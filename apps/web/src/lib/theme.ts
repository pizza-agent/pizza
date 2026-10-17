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
	/** Window/document title and brand name shown while this theme is active. */
	title?: string;
	/** App icon as a data: URI (favicon, window icon, sidebar brand mark). */
	icon?: string;
	/** Raw CSS injected only while this theme is active. */
	css?: string;
	/** Background video as a data: URI (not persisted — re-fetched on load). */
	video?: string;
	/** Launch-screen customization (persisted — the splash renders before the catalog loads). */
	splash?: { css?: string; minDurationMs?: number };
}

/** What the launch screen needs, resolved from the active theme or its persisted snapshot. */
export interface SplashSpec {
	css?: string;
	minDurationMs: number;
	icon?: string;
}

/** Mirrors MAX_SPLASH_MIN_DURATION_MS in packages/tui/theme/theme.ts. */
const MAX_SPLASH_MIN_DURATION_MS = 4000;

const STORAGE_KEY = "pizza-theme";
const MODE_KEY = "pizza-theme-mode";
const CSS_KEY = "pizza-theme-css";
const EXTRA_CSS_KEY = "pizza-theme-extra-css";
const TITLE_KEY = "pizza-theme-title";
const ICON_KEY = "pizza-theme-icon";
const SPLASH_KEY = "pizza-theme-splash";
const STYLE_ID = "pizza-custom-theme";
const EXTRA_STYLE_ID = "pizza-custom-theme-extra";
const FAVICON_ID = "pizza-theme-favicon";
const VIDEO_ID = "pizza-theme-video";
const DEFAULT_TITLE = "Pizza";

import { isTauri } from "./utils";
import { listThemes } from "./transport";

let customThemes: CustomTheme[] = [];
let styleEl: HTMLStyleElement | null = null;
let extraStyleEl: HTMLStyleElement | null = null;

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

/** Sync window title + icon to the theme's web.title/web.icon (desktop only). */
async function syncWindowChrome(custom: CustomTheme | undefined): Promise<void> {
	if (!isTauri()) return;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		const win = getCurrentWindow();
		await win.setTitle(custom?.title ?? DEFAULT_TITLE);
		if (custom?.icon?.startsWith("data:")) {
			const { Image } = await import("@tauri-apps/api/image");
			const base64 = custom.icon.slice(custom.icon.indexOf(",") + 1);
			const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			await win.setIcon(await Image.fromBytes(bytes));
		} else {
			const { Image } = await import("@tauri-apps/api/image");
			const path = getTheme() === "dark" ? "/pizza-icon-dark.png" : "/pizza-icon.png";
			const response = await fetch(path);
			if (response.ok) {
				await win.setIcon(await Image.fromBytes(new Uint8Array(await response.arrayBuffer())));
			}
		}
	} catch {
		// ignore
	}
}

/** Point the favicon at the theme icon (data: URI); removes it when the theme has none. */
function applyFavicon(icon: string | undefined): void {
	const defaultLink = document.getElementById("pizza-default-favicon") as HTMLLinkElement | null;
	if (defaultLink) defaultLink.href = getTheme() === "dark" ? "/pizza-icon-dark.png" : "/pizza-icon.png";
	let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
	if (!icon) {
		link?.remove();
		return;
	}
	if (!link) {
		link = document.createElement("link");
		link.id = FAVICON_ID;
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.type = icon.slice(5, icon.indexOf(";")) || "image/png";
	link.href = icon;
}

/**
 * Mount/remove a fixed background <video> layer behind the app content.
 * Sits at z-index -1, so it only shows through surfaces the theme makes
 * translucent (tokens) — theme css can override its styling via
 * `#pizza-theme-video` selectors.
 */
function applyVideo(src: string | undefined): void {
	let video = document.getElementById(VIDEO_ID) as HTMLVideoElement | null;
	if (!src) {
		video?.remove();
		return;
	}
	if (!video) {
		video = document.createElement("video");
		video.id = VIDEO_ID;
		video.muted = true;
		video.loop = true;
		video.autoplay = true;
		video.playsInline = true;
		video.setAttribute("aria-hidden", "true");
		video.style.cssText =
			"position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none";
		document.body.prepend(video);
	}
	if (video.dataset.src !== src) {
		video.dataset.src = src;
		video.src = src;
		void video.play().catch(() => {});
	}
}

function ensureExtraStyleEl(): HTMLStyleElement {
	if (extraStyleEl && extraStyleEl.isConnected) return extraStyleEl;
	const existing = document.getElementById(EXTRA_STYLE_ID);
	extraStyleEl = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
	extraStyleEl.id = EXTRA_STYLE_ID;
	if (!extraStyleEl.isConnected) document.head.appendChild(extraStyleEl);
	return extraStyleEl;
}

/**
 * Apply the parts of a theme CSS vars cannot express: document/window title,
 * favicon, window icon, and the theme's raw `web.css` (injected only while
 * the theme is active — it is not scoped, so it must not be pre-rendered for
 * every theme like the token stylesheet is).
 */
function applyChrome(custom: CustomTheme | undefined): void {
	document.title = custom?.title ?? DEFAULT_TITLE;
	ensureExtraStyleEl().textContent = custom?.css ?? "";
	applyFavicon(custom?.icon);
	applyVideo(custom?.video);
	void syncWindowChrome(custom);
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

/** Reactive variant of listCustomThemes — re-renders when the catalog is refreshed. */
export function useCustomThemes(): CustomTheme[] {
	const [themes, setThemes] = useState<CustomTheme[]>(customThemes);
	useEffect(() => {
		const update = () => setThemes(customThemes);
		customThemeListeners.add(update);
		return () => {
			customThemeListeners.delete(update);
		};
	}, []);
	return themes;
}

/** Notified when the custom theme catalog is (re)fetched so consumers re-render. */
const customThemeListeners = new Set<() => void>();

/** Fetch the theme catalog from the agent and (re)generate the theme stylesheet. */
export async function refreshCustomThemes(): Promise<CustomTheme[]> {
	const infos = await listThemes();
	customThemes = infos
		// Selectable web themes = themes that ship a web token map, regardless
		// of source (the built-in light/dark carry no `web` block and are
		// handled by mode toggles instead).
		.filter((t) => t.web?.tokens != null)
		.map((t) => ({
			name: t.name,
			label: t.web!.label ?? t.label ?? t.name,
			mode: t.web!.mode,
			tokens: t.web!.tokens,
			title: t.web!.title,
			icon: t.web!.icon,
			css: t.web!.css,
			video: t.web!.video,
			splash: t.web!.splash,
		}));
	injectThemesCss();
	// Re-apply: a previously saved custom theme may have just become available.
	const id = getThemeId();
	applyTheme(id);
	// Refresh the pre-paint snapshot too, so edits to the theme file reach
	// the next launch (index.html + the splash read it before this runs).
	if (findCustomTheme(id)) persistTheme(id);
	for (const listener of customThemeListeners) listener();
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
	applyChrome(custom);
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
	persistTheme(id);
}

/** Snapshot the theme into localStorage for the pre-paint script and the launch screen. */
function persistTheme(id: string): void {
	const put = (key: string, value: string | undefined) =>
		value ? localStorage.setItem(key, value) : localStorage.removeItem(key);
	try {
		localStorage.setItem(STORAGE_KEY, id);
		localStorage.setItem(MODE_KEY, getTheme());
		const custom = findCustomTheme(id);
		put(CSS_KEY, custom && renderThemeCss(custom));
		put(EXTRA_CSS_KEY, custom?.css);
		put(TITLE_KEY, custom?.title);
		put(ICON_KEY, custom?.icon);
		put(SPLASH_KEY, custom?.splash && JSON.stringify(custom.splash));
	} catch {
		/* ignore */
	}
}

function readPersistedSplash(): CustomTheme["splash"] {
	try {
		const raw = localStorage.getItem(SPLASH_KEY);
		return raw ? (JSON.parse(raw) as CustomTheme["splash"]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Launch-screen spec for the active theme. At startup the theme catalog has
 * not been fetched yet, so this falls back to the snapshot persistTheme wrote.
 */
export function getSplashSpec(): SplashSpec {
	const custom = findCustomTheme(getThemeId());
	const splash = custom ? custom.splash : readPersistedSplash();
	let icon = custom?.icon;
	if (!custom) {
		try {
			icon = localStorage.getItem(ICON_KEY) ?? undefined;
		} catch {
			/* ignore */
		}
	}
	const min = Number(splash?.minDurationMs);
	return {
		css: splash?.css,
		minDurationMs: Number.isFinite(min) ? Math.min(Math.max(min, 0), MAX_SPLASH_MIN_DURATION_MS) : 0,
		icon,
	};
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
	// Sync window background and title/icon on mount and theme change
	useEffect(() => {
		const custom = findCustomTheme(getThemeId());
		void syncWindowBackground(theme, custom?.tokens.bg);
		void syncWindowChrome(custom);
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
