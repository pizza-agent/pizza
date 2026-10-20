/**
 * Managed-Chromium executable resolution.
 *
 * Detection order (first hit wins):
 *  1. PIZZA_BROWSER_EXECUTABLE env var (explicit override, tests included)
 *  2. Chrome for Testing downloaded by the agent-browser CLI
 *     (~/.agent-browser/browsers/chrome-<version>/…)
 *  3. A system Chrome/Chromium install
 *
 * Note: CfT has no Linux ARM64 builds; on that platform only the env override
 * or a distro chromium will resolve — callers should surface a clear message
 * instead of silently failing.
 */

import { access, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedChromium } from "./types.js";

async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		const s = await stat(candidate);
		if (!s.isFile()) return false;
		await access(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isRegularFile(candidate: string): Promise<boolean> {
	try {
		return (await stat(candidate)).isFile();
	} catch {
		return false;
	}
}

/** Compare dotted numeric versions; returns positive when a > b. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Platform-specific binary candidates inside a chrome install directory. */
function chromeBinaryCandidates(dir: string): string[] {
	if (process.platform === "darwin") {
		return [
			path.join(dir, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
			path.join(dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
			path.join(dir, "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
		];
	}
	if (process.platform === "win32") {
		return [path.join(dir, "chrome.exe"), path.join(dir, "chrome-win64", "chrome.exe")];
	}
	return [path.join(dir, "chrome"), path.join(dir, "chrome-linux64", "chrome")];
}

/** Scan agent-browser's browser cache for the newest Chrome for Testing. */
async function findAgentBrowserChromium(): Promise<ResolvedChromium | undefined> {
	const browsersDir = path.join(os.homedir(), ".agent-browser", "browsers");
	let entries: string[];
	try {
		entries = await readdir(browsersDir);
	} catch {
		return undefined;
	}
	const chromeDirs = entries
		.filter((name) => name.startsWith("chrome-"))
		.map((name) => ({ name, version: name.slice("chrome-".length) }))
		.filter((e) => e.version.length > 0 && /\d/.test(e.version))
		.sort((a, b) => compareVersions(b.version, a.version));
	for (const { name, version } of chromeDirs) {
		const dir = path.join(browsersDir, name);
		for (const candidate of chromeBinaryCandidates(dir)) {
			if (await isExecutableFile(candidate)) {
				return { executablePath: candidate, source: "agent-browser", version };
			}
		}
	}
	return undefined;
}

/** Well-known system Chrome/Chromium locations per platform. */
function systemChromeCandidates(): string[] {
	if (process.platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		];
	}
	if (process.platform === "win32") {
		const prefix = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
		const prefix86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
		const local = process.env["LOCALAPPDATA"];
		return [
			path.join(prefix, "Google", "Chrome", "Application", "chrome.exe"),
			path.join(prefix86, "Google", "Chrome", "Application", "chrome.exe"),
			...(local ? [path.join(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
		];
	}
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
}

async function findSystemChromium(): Promise<ResolvedChromium | undefined> {
	for (const candidate of systemChromeCandidates()) {
		if (await isExecutableFile(candidate)) {
			return { executablePath: candidate, source: "system" };
		}
	}
	return undefined;
}

/**
 * Resolve the managed-Chromium executable. Pure filesystem probing — never
 * spawns a process, safe to call from status pages.
 */
export async function resolveChromium(): Promise<ResolvedChromium | undefined> {
	const envPath = process.env["PIZZA_BROWSER_EXECUTABLE"]?.trim();
	if (envPath && (await isExecutableFile(envPath))) {
		return { executablePath: path.resolve(envPath), source: "env" };
	}
	return (await findAgentBrowserChromium()) ?? (await findSystemChromium());
}

/** Human-readable one-liner for status output. */
export async function chromiumStatusLine(): Promise<string> {
	const resolved = await resolveChromium();
	if (!resolved) {
		return "managed chromium: not found — set PIZZA_BROWSER_EXECUTABLE, install Chrome for Testing via /browser install, or install Google Chrome";
	}
	const label =
		resolved.source === "env"
			? "PIZZA_BROWSER_EXECUTABLE"
			: resolved.source === "agent-browser"
				? `agent-browser Chrome for Testing${resolved.version ? ` ${resolved.version}` : ""}`
				: "system Chrome";
	return `managed chromium: ${resolved.executablePath} (${label})`;
}

export { isRegularFile };
