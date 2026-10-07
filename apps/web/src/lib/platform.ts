/**
 * Platform detection helpers — zero-dependency so they can be imported
 * from test-transitive paths (transport.ts → file-attachment.ts) without
 * pulling in clsx/tailwind-merge, which are web-only and not installed
 * in the root package.json that CI uses for `npm test`.
 */

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * True on macOS (and iOS WebViews). Used to decide whether to reserve
 * space for the macOS traffic-light window controls — the Tauri window
 * uses titleBarStyle "Overlay", which only exists on macOS; Windows/Linux
 * render a normal title bar, so no padding is needed there.
 */
export function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	const p = navigator.platform ?? "";
	const ua = navigator.userAgent ?? "";
	return /Mac|iPhone|iPad|iPod/.test(p) || /Macintosh/.test(ua);
}

/** True when the UI must reserve space for macOS overlay window controls. */
export function hasMacTrafficLights(): boolean {
	return isTauri() && isMac();
}

/**
 * Normalize a filesystem path for equality checks across platforms:
 * `\` → `/`, collapse duplicate separators, drop trailing separators.
 * On Windows the same workspace can appear as `C:\Users\x\.pizza\main`
 * (Rust-side `~` expansion) or `C:\Users\x/.pizza/main` (JS-side
 * `homeDir()` + replace), so comparing raw strings is unreliable.
 */
export function normalizePathForCompare(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** True when `a` and `b` refer to the same filesystem path. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (a == null || b == null) return a === b;
	return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** The persistent Chat workspace is always `~/.pizza/main`. */
export const MAIN_CHAT_CWD = "~/.pizza/main";

/** True when `cwd` refers to the persistent Chat workspace (`~/.pizza/main`),
 * whether still tilde-prefixed or already expanded to an absolute path. */
export function isMainChatCwd(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	if (cwd === MAIN_CHAT_CWD) return true;
	return normalizePathForCompare(cwd).endsWith("/.pizza/main");
}

/** Last path component, tolerating both `/` and `\` separators. */
export function pathBasename(path: string): string {
	const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] || path;
}
