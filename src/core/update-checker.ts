/**
 * Automatic update detection.
 *
 * Pizza is distributed through two channels:
 *  - npm (`@tomsun28/pizza`) — CLI installed via npm/pnpm/yarn/bun
 *  - GitHub releases — standalone binary (bun-compiled) and desktop installers
 *    (dmg/deb/rpm/exe/msi)
 *
 * This module detects the install method, queries the matching registry for
 * the latest published version, compares it against the running version and
 * returns an actionable result (update command or download URL). Results are
 * cached in the agent dir with a TTL so interactive sessions don't hit the
 * network on every launch.
 *
 * All failures are silent-by-design: an update check must never block or
 * crash a session. Respect `PIZZA_SKIP_VERSION_CHECK` / `PIZZA_OFFLINE` and
 * the `autoUpdateCheck` setting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type InstallMethod,
	VERSION,
	detectInstallMethod,
	getAgentDir,
	getUpdateInstruction,
} from "../config.js";

/** Where the "what's the latest version" answer comes from. */
export type UpdateSource = "npm" | "github";

export interface UpdateCheckResult {
	/** Version of the running instance. */
	currentVersion: string;
	/** Latest published version for the detected install channel. */
	latestVersion: string;
	/** True when latestVersion > currentVersion. */
	updateAvailable: boolean;
	/** Which registry was queried. */
	source: UpdateSource;
	/** Human-readable update instruction (e.g. `npm install -g @tomsun28/pizza`). */
	updateInstruction: string;
	/** Browser URL for the release (GitHub releases page). */
	releaseUrl?: string;
	/** ISO timestamp of when the check ran. */
	checkedAt: string;
	/** True when this result came from the on-disk cache. */
	fromCache?: boolean;
}

export interface UpdateCheckOptions {
	/** Bypass the TTL cache and hit the registry. Default false. */
	force?: boolean;
	/** Cache directory. Defaults to the agent dir. */
	cacheDir?: string;
	/** Injectable clock for tests. */
	now?: () => Date;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
	/** Network timeout per request in ms. Default 5000. */
	timeoutMs?: number;
	/** Override install-method detection for tests. */
	installMethod?: InstallMethod;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const NPM_PACKAGE = "@tomsun28/pizza";
const GITHUB_REPO = "pizza-agent/pizza";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2F")}/latest`;
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

/** How long a cached check stays fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILENAME = "update-check.json";
const USER_AGENT = `pizza/${VERSION} (${GITHUB_REPO})`;

// ─── Semver comparison ──────────────────────────────────────────────────────

export interface SemverParts {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

/**
 * Parse a semver string (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`). Returns null for
 * non-version strings (e.g. git describe suffixes are not supported).
 */
export function parseSemver(version: string): SemverParts | null {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
	};
}

/**
 * Compare two version strings. Returns:
 *   -1 when a < b, 0 when a === b, 1 when a > b
 * Unparseable versions sort lowest. Prereleases sort below their release
 * (1.0.0-rc.1 < 1.0.0), per semver spec.
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa && !pb) return 0;
	if (!pa) return -1;
	if (!pb) return 1;

	if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
	if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
	if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

	// Prerelease precedence: a version WITHOUT prerelease is greater.
	if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
	if (pa.prerelease.length === 0) return 1;
	if (pb.prerelease.length === 0) return -1;

	const len = Math.max(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < len; i++) {
		const x = pa.prerelease[i];
		const y = pb.prerelease[i];
		if (x === undefined) return -1; // shorter set of prerelease fields is lower
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const ix = Number(x);
			const iy = Number(y);
			if (ix !== iy) return ix > iy ? 1 : -1;
		} else if (nx) return -1; // numeric identifiers are lower than alphanumeric
		else if (ny) return 1;
		else if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

// ─── Registry fetchers ──────────────────────────────────────────────────────

function fetchWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return fetchImpl(url, {
		signal: controller.signal,
		headers: {
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		},
	}).finally(() => clearTimeout(timer));
}

/** Latest published version on the npm registry. */
export async function fetchLatestNpmVersion(
	fetchImpl: typeof fetch,
	timeoutMs = 5000,
): Promise<string | undefined> {
	const response = await fetchWithTimeout(NPM_REGISTRY_URL, fetchImpl, timeoutMs);
	if (!response.ok) return undefined;
	const body = (await response.json()) as { version?: string };
	return typeof body.version === "string" ? body.version : undefined;
}

export interface GitHubReleaseInfo {
	/** Release tag with a leading `v` stripped, when parseable. */
	version?: string;
	/** Raw tag (e.g. `v0.4.0`). */
	tag: string;
	/** Browser URL of the release page. */
	url: string;
	/** Asset download URLs for the release (installers). */
	assetUrls: string[];
}

/** Latest published GitHub release (name, tag, assets). */
export async function fetchLatestGitHubRelease(
	fetchImpl: typeof fetch,
	timeoutMs = 5000,
): Promise<GitHubReleaseInfo | undefined> {
	const response = await fetchWithTimeout(GITHUB_RELEASES_API, fetchImpl, timeoutMs);
	if (!response.ok) return undefined;
	const body = (await response.json()) as {
		tag_name?: string;
		html_url?: string;
		assets?: Array<{ browser_download_url?: string }>;
		draft?: boolean;
		prerelease?: boolean;
	};
	if (!body.tag_name || body.draft) return undefined;
	const tag = body.tag_name;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	return {
		version,
		tag,
		url: body.html_url ?? GITHUB_RELEASES_PAGE,
		assetUrls: (body.assets ?? [])
			.map((a) => a.browser_download_url)
			.filter((u): u is string => typeof u === "string"),
	};
}

// ─── Update instruction per channel ─────────────────────────────────────────

/**
 * Find the installer asset matching the current platform, following the
 * `Pizza_<version>_<platform>_<arch>.<ext>` naming scheme from the desktop
 * release workflow.
 */
export function pickDesktopAsset(
	assetUrls: string[],
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
): string | undefined {
	const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
	// Requested arch first; fall back to the other one because the release
	// workflow does not publish every platform/arch combination (windows and
	// linux are x64-only today, so an arm64 host still gets a usable asset).
	const archs: NodeJS.Architecture[] = arch === "arm64" ? ["arm64", "x64"] : ["x64", "arm64"];
	const suffixes =
		platform === "darwin"
			? [".dmg"]
			: platform === "win32"
				? ["-setup.exe", ".exe", ".msi"]
				: [".deb", ".rpm", ".AppImage"];
	for (const candidate of archs) {
		for (const suffix of suffixes) {
			const match = assetUrls.find((u) => u.includes(`_${os}_${candidate}`) && u.endsWith(suffix));
			if (match) return match;
		}
	}
	return undefined;
}

function buildUpdateInstruction(source: UpdateSource, assetUrl?: string): string {
	if (source === "npm") {
		return getUpdateInstruction(NPM_PACKAGE);
	}
	if (assetUrl) {
		return `Download: ${assetUrl}`;
	}
	return `Download the latest release from ${GITHUB_RELEASES_PAGE}`;
}

function sourceForInstallMethod(method: InstallMethod): UpdateSource {
	// npm-family installs track the npm registry; binaries and anything unknown
	// fall back to GitHub releases, which is where binaries are published.
	return method === "bun-binary" || method === "unknown" ? "github" : "npm";
}

// ─── Cache ──────────────────────────────────────────────────────────────────

export function getUpdateCheckCachePath(cacheDir?: string): string {
	return join(cacheDir ?? getAgentDir(), CACHE_FILENAME);
}

interface CachePayload extends UpdateCheckResult {}

function readCache(path: string, now: Date): CachePayload | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf-8")) as CachePayload;
		if (typeof raw.latestVersion !== "string" || typeof raw.checkedAt !== "string") return undefined;
		// Invalidate when the running version changes (e.g. user updated but the
		// cached result still says an update is available).
		if (raw.currentVersion !== VERSION) return undefined;
		const age = now.getTime() - new Date(raw.checkedAt).getTime();
		if (Number.isNaN(age) || age > CACHE_TTL_MS) return undefined;
		return raw;
	} catch {
		return undefined;
	}
}

function writeCache(path: string, result: UpdateCheckResult): void {
	try {
		const dir = join(path, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(result, null, "\t") + "\n");
	} catch {
		// Cache write failures are never fatal.
	}
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * True when update checks are disabled via environment.
 * (`PIZZA_OFFLINE` implies `PIZZA_SKIP_VERSION_CHECK` — see main.ts.)
 */
export function isUpdateCheckDisabledByEnv(): boolean {
	return (
		process.env.PIZZA_SKIP_VERSION_CHECK === "1" ||
		process.env.PIZZA_OFFLINE === "1" ||
		process.env.PIZZA_SKIP_VERSION_CHECK?.toLowerCase() === "true" ||
		process.env.PIZZA_OFFLINE?.toLowerCase() === "true"
	);
}

/**
 * Check for a newer release. Never throws — network/registry failures return
 * undefined so callers can simply skip the notice.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult | undefined> {
	if (isUpdateCheckDisabledByEnv()) return undefined;

	const { force = false, now = () => new Date(), fetchImpl = fetch, timeoutMs = 5000 } = options;
	const method = options.installMethod ?? detectInstallMethod();
	const source = sourceForInstallMethod(method);
	const cachePath = getUpdateCheckCachePath(options.cacheDir);

	if (!force) {
		const cached = readCache(cachePath, now());
		if (cached) return { ...cached, fromCache: true };
	}

	try {
		let latestVersion: string | undefined;
		let releaseUrl: string | undefined;
		let assetUrl: string | undefined;

		if (source === "npm") {
			latestVersion = await fetchLatestNpmVersion(fetchImpl, timeoutMs);
		} else {
			const release = await fetchLatestGitHubRelease(fetchImpl, timeoutMs);
			latestVersion = release?.version;
			releaseUrl = release?.url;
			assetUrl = release ? pickDesktopAsset(release.assetUrls) : undefined;
		}

		if (!latestVersion) return undefined;

		const result: UpdateCheckResult = {
			currentVersion: VERSION,
			latestVersion,
			updateAvailable: compareSemver(latestVersion, VERSION) > 0,
			source,
			updateInstruction: buildUpdateInstruction(source, assetUrl),
			releaseUrl: releaseUrl ?? (source === "github" ? GITHUB_RELEASES_PAGE : undefined),
			checkedAt: now().toISOString(),
		};
		writeCache(cachePath, result);
		return result;
	} catch {
		// Network errors, timeouts, JSON errors — all silent.
		return undefined;
	}
}

/**
 * Format the one-line notice for an available update, used by the TUI and CLI.
 */
export function formatUpdateNotice(result: UpdateCheckResult): string {
	return `Pizza ${result.latestVersion} is available (you are on ${result.currentVersion}). ${result.updateInstruction}`;
}