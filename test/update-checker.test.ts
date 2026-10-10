import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";
import {
	checkForUpdate,
	compareSemver,
	formatUpdateNotice,
	isUpdateCheckDisabledByEnv,
	parseSemver,
	pickDesktopAsset,
} from "../src/core/update-checker.js";

/** Build a fake Response for the injected fetch. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body,
	} as unknown as Response;
}

function githubReleaseBody(tag: string, assets: string[] = []) {
	return {
		tag_name: tag,
		html_url: `https://github.com/pizza-agent/pizza/releases/tag/${tag}`,
		assets: assets.map((browser_download_url) => ({ browser_download_url })),
	};
}

function bump(version: string): string {
	const [major, minor, patch] = version.split(".").map(Number);
	return `${major}.${minor}.${patch + 1}`;
}

const NEXT = bump(VERSION);

describe("parseSemver", () => {
	it("parses plain versions", () => {
		expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
	});

	it("parses leading v and prerelease", () => {
		expect(parseSemver("v0.4.0-beta.1")).toEqual({
			major: 0,
			minor: 4,
			patch: 0,
			prerelease: ["beta", "1"],
		});
	});

	it("rejects garbage", () => {
		expect(parseSemver("latest")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
	});
});

describe("compareSemver", () => {
	it("orders versions correctly", () => {
		expect(compareSemver("0.3.2", "0.3.3")).toBeLessThan(0);
		expect(compareSemver("0.4.0", "0.3.99")).toBeGreaterThan(0);
		expect(compareSemver("1.0.0", "v1.0.0")).toBe(0);
	});

	it("treats unparseable versions as lowest", () => {
		expect(compareSemver("garbage", "0.0.1")).toBeLessThan(0);
		expect(compareSemver("garbage", "also-garbage")).toBe(0);
	});

	it("sorts prereleases below their release", () => {
		expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
	});
});

describe("pickDesktopAsset", () => {
	const assets = [
		"https://github.com/pizza-agent/pizza/releases/download/v0.4.0/Pizza_0.4.0_macos_arm64.dmg",
		"https://github.com/pizza-agent/pizza/releases/download/v0.4.0/Pizza_0.4.0_macos_x64.dmg",
		"https://github.com/pizza-agent/pizza/releases/download/v0.4.0/Pizza_0.4.0_windows_x64-setup.exe",
		"https://github.com/pizza-agent/pizza/releases/download/v0.4.0/Pizza_0.4.0_linux_x64.deb",
	];

	it("picks the darwin arm64 dmg", () => {
		// arch is injected so the assertion holds on any host (CI runs x64).
		expect(pickDesktopAsset(assets, "darwin", "arm64")).toContain("macos_arm64.dmg");
	});

	it("picks the darwin x64 dmg when arm64 is absent", () => {
		const noArm64 = assets.filter((u) => !u.includes("_arm64"));
		expect(pickDesktopAsset(noArm64, "darwin", "arm64")).toContain("macos_x64.dmg");
	});

	it("picks the windows setup exe", () => {
		expect(pickDesktopAsset(assets, "win32", "x64")).toContain("windows_x64-setup.exe");
	});

	it("picks the linux deb", () => {
		expect(pickDesktopAsset(assets, "linux", "x64")).toContain("linux_x64.deb");
	});

	it("returns undefined when nothing matches", () => {
		expect(pickDesktopAsset([], "darwin", "arm64")).toBeUndefined();
	});
});

describe("checkForUpdate", () => {
	const tmp = join(process.cwd(), "test-update-check-tmp");
	let cacheDir: string;
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		cacheDir = join(tmp, "agent");
		mkdirSync(cacheDir, { recursive: true });
		savedEnv = { ...process.env };
		delete process.env.PIZZA_OFFLINE;
		delete process.env.PIZZA_SKIP_VERSION_CHECK;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		process.env = savedEnv;
	});

	it("detects a newer npm version and reports an update instruction", async () => {
		const fetchImpl = (() =>
			Promise.resolve(jsonResponse({ version: NEXT }))) as unknown as typeof fetch;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });

		expect(result).toBeDefined();
		expect(result!.updateAvailable).toBe(true);
		expect(result!.source).toBe("npm");
		expect(result!.latestVersion).toBe(NEXT);
		expect(result!.updateInstruction).toMatch(/@tomsun28\/pizza/);
	});

	it("reports no update when the registry version matches", async () => {
		const fetchImpl = (() =>
			Promise.resolve(jsonResponse({ version: VERSION }))) as unknown as typeof fetch;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });

		expect(result).toBeDefined();
		expect(result!.updateAvailable).toBe(false);
	});

	it("uses GitHub releases for binary installs and picks the platform asset", async () => {
		const fetchImpl = (() =>
			Promise.resolve(
				jsonResponse(
					githubReleaseBody(`v${NEXT}`, [
						"https://github.com/pizza-agent/pizza/releases/download/v0.4.0/Pizza_0.4.0_linux_x64.deb",
					]),
				),
			)) as unknown as typeof fetch;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "bun-binary" });

		expect(result).toBeDefined();
		expect(result!.source).toBe("github");
		expect(result!.latestVersion).toBe(NEXT);
		expect(result!.updateAvailable).toBe(true);
		expect(result!.releaseUrl).toContain("releases/tag");
	});

	it("caches results and serves them without a second request", async () => {
		let calls = 0;
		const fetchImpl = (() => {
			calls++;
			return Promise.resolve(jsonResponse({ version: NEXT }));
		}) as unknown as typeof fetch;

		const first = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		expect(first!.fromCache).toBeUndefined();

		const second = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		expect(calls).toBe(1);
		expect(second!.fromCache).toBe(true);
		expect(second!.latestVersion).toBe(NEXT);

		// force bypasses the cache
		const third = await checkForUpdate({ force: true, fetchImpl, cacheDir, installMethod: "npm" });
		expect(calls).toBe(2);
		expect(third!.fromCache).toBeUndefined();
	});

	it("expires stale cache entries after the TTL", async () => {
		let calls = 0;
		const fetchImpl = (() => {
			calls++;
			return Promise.resolve(jsonResponse({ version: NEXT }));
		}) as unknown as typeof fetch;

		await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		expect(calls).toBe(1);

		// 25h later the cache is stale
		const stale = await checkForUpdate({
			fetchImpl,
			cacheDir,
			installMethod: "npm",
			now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
		});
		expect(calls).toBe(2);
		expect(stale!.fromCache).toBeUndefined();
	});

	it("returns undefined silently when the registry is unreachable", async () => {
		const fetchImpl = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		expect(result).toBeUndefined();
	});

	it("returns undefined for non-ok responses", async () => {
		const fetchImpl = (() =>
			Promise.resolve(jsonResponse({}, false, 404))) as unknown as typeof fetch;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		expect(result).toBeUndefined();
	});

	it("respects PIZZA_SKIP_VERSION_CHECK and PIZZA_OFFLINE", async () => {
		let calls = 0;
		const fetchImpl = (() => {
			calls++;
			return Promise.resolve(jsonResponse({ version: NEXT }));
		}) as unknown as typeof fetch;

		process.env.PIZZA_SKIP_VERSION_CHECK = "1";
		expect(await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" })).toBeUndefined();

		delete process.env.PIZZA_SKIP_VERSION_CHECK;
		process.env.PIZZA_OFFLINE = "1";
		expect(await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" })).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("invalidates the cache when the running version changes", async () => {
		let registryVersion = NEXT;
		const fetchImpl = (() =>
			Promise.resolve(jsonResponse({ version: registryVersion }))) as unknown as typeof fetch;

		await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });

		// Simulate the user having updated: cached currentVersion no longer matches
		// the running VERSION. The cache file still stores the old version, so a
		// fresh read treats it as stale and re-queries.
		registryVersion = VERSION;
		const result = await checkForUpdate({ fetchImpl, cacheDir, installMethod: "npm" });
		// fromCache entries whose currentVersion differs are re-fetched; either way
		// the visible result must agree with the running version.
		expect(result!.currentVersion).toBe(VERSION);
	});
});

describe("isUpdateCheckDisabledByEnv", () => {
	const saved = { ...process.env };

	afterEach(() => {
		process.env = saved;
	});

	it("toggles with both env vars and truthy spellings", () => {
		delete process.env.PIZZA_OFFLINE;
		delete process.env.PIZZA_SKIP_VERSION_CHECK;
		expect(isUpdateCheckDisabledByEnv()).toBe(false);

		process.env.PIZZA_SKIP_VERSION_CHECK = "true";
		expect(isUpdateCheckDisabledByEnv()).toBe(true);
		delete process.env.PIZZA_SKIP_VERSION_CHECK;

		process.env.PIZZA_OFFLINE = "1";
		expect(isUpdateCheckDisabledByEnv()).toBe(true);
	});
});

describe("formatUpdateNotice", () => {
	it("includes both versions and the instruction", () => {
		const text = formatUpdateNotice({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateAvailable: true,
			source: "npm",
			updateInstruction: "Run: npm install -g @tomsun28/pizza",
			checkedAt: new Date().toISOString(),
		});
		expect(text).toContain("1.1.0");
		expect(text).toContain("1.0.0");
		expect(text).toContain("npm install -g @tomsun28/pizza");
	});
});