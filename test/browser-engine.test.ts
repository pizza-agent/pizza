/**
 * Unit tests for the browser-use engine: navigation policy, Chromium
 * executable resolution, frame-server security validators, and the `_browser`
 * builtin command surface. All offline — no browser launch happens here
 * (the real-browser flow lives in browser-engine-integration.test.ts).
 */

import { mkdtemp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAddress, NavigationPolicy, normalizeUrl } from "../src/core/browser/policy.js";
import { resolveChromium } from "../src/core/browser/chromium.js";
import {
	BrowserFrameServer,
	isAllowedFrameHost,
	isAllowedFrameOrigin,
} from "../src/core/browser/frame-server.js";
import { browserBuiltinCommand } from "../src/builtin-extensions/agent-browser/browser-builtin.js";
import { getBrowserController } from "../src/core/browser/controller.js";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// URL normalization + address classification
// ---------------------------------------------------------------------------

describe("browser policy: normalizeUrl", () => {
	it("adds https:// to bare hosts", () => {
		expect(normalizeUrl("example.com")?.href).toBe("https://example.com/");
	});

	it("keeps an explicit scheme", () => {
		expect(normalizeUrl("http://127.0.0.1:8080/x")?.href).toBe("http://127.0.0.1:8080/x");
	});

	it("rejects garbage", () => {
		expect(normalizeUrl("")).toBeNull();
		expect(normalizeUrl("   ")).toBeNull();
	});
});

describe("browser policy: classifyAddress", () => {
	it("recognizes loopback in all its shapes", () => {
		expect(classifyAddress("127.0.0.1")).toBe("loopback");
		expect(classifyAddress("127.8.9.10")).toBe("loopback");
		expect(classifyAddress("localhost")).toBe("loopback");
		expect(classifyAddress("api.localhost")).toBe("loopback");
		expect(classifyAddress("::1")).toBe("loopback");
	});

	it("recognizes private ranges", () => {
		expect(classifyAddress("10.1.2.3")).toBe("private");
		expect(classifyAddress("172.16.0.9")).toBe("private");
		expect(classifyAddress("192.168.1.1")).toBe("private");
		expect(classifyAddress("fd00::1")).toBe("private");
	});

	it("recognizes link-local", () => {
		expect(classifyAddress("169.254.1.1")).toBe("link-local");
		expect(classifyAddress("fe80::1")).toBe("link-local");
	});

	it("treats normal hosts as public", () => {
		expect(classifyAddress("example.com")).toBe("public");
		expect(classifyAddress("8.8.8.8")).toBe("public");
	});

	it("rejects the any-address", () => {
		expect(classifyAddress("0.0.0.0")).toBe("invalid");
	});
});

describe("browser policy: NavigationPolicy", () => {
	it("blocks non-http schemes outright", () => {
		const policy = new NavigationPolicy();
		for (const url of [
			"file:///etc/passwd",
			"chrome://settings",
			"devtools://devtools",
			"about:blank",
			"data:text/html,<script>1</script>",
			"javascript:alert(1)",
			"view-source:https://example.com",
		]) {
			const decision = policy.classify(url);
			expect(decision.decision, url).toBe("block");
			expect(decision.reason, url).toMatch(/^scheme_not_allowed/);
		}
	});

	it("allows loopback automatically (local dev servers are a primary use case)", () => {
		const policy = new NavigationPolicy();
		const decision = policy.classify("http://127.0.0.1:5173/");
		expect(decision.decision).toBe("allow");
		// Second time it hits the session allowlist (no reason).
		expect(policy.classify("http://127.0.0.1:5173/other").decision).toBe("allow");
	});

	it("normalizes hex/decimal IPv4 trickery through the WHATWG parser", () => {
		const policy = new NavigationPolicy();
		// 0x7f000001 == 127.0.0.1; the URL parser canonicalizes it before we see it.
		expect(policy.classify("http://0x7f000001/").origin).toBe("http://127.0.0.1");
		expect(policy.classify("http://2130706433/").origin).toBe("http://127.0.0.1");
	});

	it("auto mode allows public and private origins with audit reasons", () => {
		const policy = new NavigationPolicy({ approvalMode: "auto" });
		expect(policy.classify("https://example.com").decision).toBe("allow");
		const lan = policy.classify("http://192.168.1.10:8080/");
		expect(lan.decision).toBe("allow");
		expect(lan.reason).toMatch(/^non_public_origin_auto/);
	});

	it("approve mode asks for new public and non-loopback private origins", () => {
		const policy = new NavigationPolicy({ approvalMode: "on" });
		expect(policy.classify("https://example.com").decision).toBe("ask");
		expect(policy.classify("http://10.0.0.5/").decision).toBe("ask");
		// loopback stays allowed even in approve mode
		expect(policy.classify("http://localhost:3000/").decision).toBe("allow");
	});

	it("check() fails closed when ask has no resolver", async () => {
		const policy = new NavigationPolicy({ approvalMode: "on" });
		const decision = await policy.check("https://example.com", "test");
		expect(decision.decision).toBe("block");
		expect(decision.decidedBy).toBe("fail_closed");
	});

	it("check() honors the approval resolver and remembers approvals", async () => {
		const decisions: Array<[string, string]> = [];
		const policy = new NavigationPolicy({
			approvalMode: "on",
			resolveApproval: async (url, reason) => {
				decisions.push([url, reason]);
				return true;
			},
		});
		const first = await policy.check("https://example.com", "test");
		expect(first.decision).toBe("allow");
		expect(first.reason).toBe("user_approved");
		expect(decisions).toHaveLength(1);
		// Approved origin is remembered for the session — no second prompt.
		const second = await policy.check("https://example.com/other", "test");
		expect(second.decision).toBe("allow");
		expect(decisions).toHaveLength(1);
	});

	it("check() denies when the resolver returns false", async () => {
		const policy = new NavigationPolicy({
			approvalMode: "on",
			resolveApproval: async () => false,
		});
		const decision = await policy.check("https://example.com", "test");
		expect(decision.decision).toBe("block");
	});

	it("reset() forgets session approvals", async () => {
		const policy = new NavigationPolicy({
			approvalMode: "on",
			resolveApproval: async () => true,
		});
		await policy.check("https://example.com", "test");
		policy.reset();
		expect(policy.classify("https://example.com").decision).toBe("ask");
	});
});

// ---------------------------------------------------------------------------
// Chromium resolution (agent-browser cache layout, env override)
// ---------------------------------------------------------------------------

describe("chromium resolution", () => {
	const previousEnv = process.env["PIZZA_BROWSER_EXECUTABLE"];
	// os.homedir() reads HOME on unix but USERPROFILE on Windows — fake both
	// so the agent-browser cache scan targets our temp dir everywhere.
	const previousHome = process.env["HOME"];
	const previousUserProfile = process.env["USERPROFILE"];
	let fakeHome: string;

	beforeAll(async () => {
		fakeHome = await mkdtemp(path.join(tmpdir(), "pizza-browser-test-"));
		process.env["USERPROFILE"] = fakeHome;
		// Two CfT installs: an older 131 and a newer 137 — the newer must win.
		const layouts =
			process.platform === "darwin"
				? ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
				: process.platform === "win32"
					? ["chrome.exe"]
					: ["chrome"];
		for (const [version, layout] of [
			["131.0.1", layouts[0]!],
			["137.0.2", layouts[0]!],
		] as const) {
			const binary = path.join(fakeHome, ".agent-browser", "browsers", `chrome-${version}`, layout);
			await mkdir(path.dirname(binary), { recursive: true });
			await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
			await chmod(binary, 0o755);
		}
		process.env["HOME"] = fakeHome;
		delete process.env["PIZZA_BROWSER_EXECUTABLE"];
	});

	afterAll(async () => {
		if (previousHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = previousHome;
		if (previousUserProfile === undefined) delete process.env["USERPROFILE"];
		else process.env["USERPROFILE"] = previousUserProfile;
		if (previousEnv === undefined) delete process.env["PIZZA_BROWSER_EXECUTABLE"];
		else process.env["PIZZA_BROWSER_EXECUTABLE"] = previousEnv;
		await rm(fakeHome, { recursive: true, force: true });
	});

	it("picks the newest agent-browser Chrome for Testing install", async () => {
		const resolved = await resolveChromium();
		expect(resolved).toBeDefined();
		expect(resolved!.source).toBe("agent-browser");
		expect(resolved!.version).toBe("137.0.2");
		expect(resolved!.executablePath).toContain("chrome-137.0.2");
	});

	it("the env override wins when it points at an executable", async () => {
		const override = path.join(fakeHome, "custom-chrome");
		await writeFile(override, "#!/bin/sh\n", { mode: 0o755 });
		process.env["PIZZA_BROWSER_EXECUTABLE"] = override;
		try {
			const resolved = await resolveChromium();
			expect(resolved!.source).toBe("env");
			expect(resolved!.executablePath).toBe(override);
		} finally {
			delete process.env["PIZZA_BROWSER_EXECUTABLE"];
		}
	});
});

// ---------------------------------------------------------------------------
// Frame-server security validators
// ---------------------------------------------------------------------------

describe("frame server origin/host validators", () => {
	it("allows loopback, localhost, and tauri origins", () => {
		expect(isAllowedFrameOrigin(undefined)).toBe(true);
		expect(isAllowedFrameOrigin("http://127.0.0.1:1420")).toBe(true);
		expect(isAllowedFrameOrigin("http://localhost:1420")).toBe(true);
		expect(isAllowedFrameOrigin("tauri://localhost")).toBe(true);
		expect(isAllowedFrameOrigin("http://tauri.localhost")).toBe(true);
	});

	it("rejects remote and non-http origins", () => {
		expect(isAllowedFrameOrigin("https://evil.example.com")).toBe(false);
		expect(isAllowedFrameOrigin("file:///")).toBe(false);
		expect(isAllowedFrameOrigin("not a url")).toBe(false);
	});

	it("requires a loopback Host header (DNS-rebinding guard)", () => {
		expect(isAllowedFrameHost("127.0.0.1:54321")).toBe(true);
		expect(isAllowedFrameHost("localhost:54321")).toBe(true);
		expect(isAllowedFrameHost(undefined)).toBe(false);
		expect(isAllowedFrameHost("evil.example.com:54321")).toBe(false);
		expect(isAllowedFrameHost("[::1]:54321")).toBe(false); // host header hostname "::1" — currently only 127.0.0.1/localhost accepted
	});
});

// ---------------------------------------------------------------------------
// Frame-server token coexistence (regression: concurrent browser_get_state
// callers used to invalidate each other's token, looping the panel in
// "connecting…" forever)
// ---------------------------------------------------------------------------

describe("frame server token coexistence", () => {
	function connectAndExpectHello(server: BrowserFrameServer, token: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`);
			const timer = setTimeout(() => reject(new Error("hello timeout")), 5000);
			ws.on("message", (data, isBinary) => {
				if (isBinary) return;
				const message = JSON.parse(String(data)) as { type: string };
				if (message.type === "hello") {
					clearTimeout(timer);
					ws.close();
					resolve();
				}
			});
			ws.on("close", (code) => {
				clearTimeout(timer);
				reject(new Error(`closed before hello: ${code}`));
			});
			ws.on("error", (e) => reject(e));
		});
	}

	function expectCloseCode(server: BrowserFrameServer, token: string, code: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`);
			const timer = setTimeout(() => reject(new Error("no close")), 5000);
			ws.on("close", (got) => {
				clearTimeout(timer);
				if (got === code) resolve();
				else reject(new Error(`expected close ${code}, got ${got}`));
			});
			ws.on("error", () => { /* close follows */ });
		});
	}

	it("concurrent credentials stay valid; consumed tokens stay dead", async () => {
		const controller = getBrowserController();
		const server = await BrowserFrameServer.start(controller);
		try {
			// Two panels (or panel + diagnostic) fetch credentials back to back.
			const first = server.getCredentials();
			const second = server.getCredentials();
			expect(first.token).not.toBe(second.token);
			// The earlier token must STILL work — this is the regression.
			await connectAndExpectHello(server, first.token);
			await connectAndExpectHello(server, second.token);
			// Replay of a consumed token is rejected with the handshake code.
			await expectCloseCode(server, first.token, 4401);
			// Garbage token rejected too.
			await expectCloseCode(server, "not-a-token", 4401);
		} finally {
			await server.close();
		}
	}, 20_000);
});

// ---------------------------------------------------------------------------
// _browser builtin command surface
// ---------------------------------------------------------------------------

describe("_browser builtin command", () => {
	it("rejects unknown subcommands with usage help", () => {
		expect(() => browserBuiltinCommand.parseArguments(["frobnicate"])).toThrow(/Unknown _browser subcommand/);
	});

	it("parses open with positional url and --new", () => {
		const params = browserBuiltinCommand.parseArguments(["open", "https://example.com", "--new"]);
		expect(params["subcommand"]).toBe("open");
		expect(params["__positional"]).toEqual(["https://example.com"]);
		expect(params["new"]).toBe(true);
	});

	it("parses click ref and coordinate forms", () => {
		const ref = browserBuiltinCommand.parseArguments(["click", "@e3"]);
		expect(ref["__positional"]).toEqual(["@e3"]);
		const coords = browserBuiltinCommand.parseArguments(["click", "--x", "10", "--y", "20", "--frame", "7"]);
		expect(coords["x"]).toBe("10");
		expect(coords["frame"]).toBe("7");
	});

	it("status works without launching a browser", async () => {
		const result = await browserBuiltinCommand.execute("tc1", { subcommand: "status" }, undefined, undefined, {} as never);
		const text = result.content[0];
		expect(text?.type).toBe("text");
		expect(String((text as { text?: string }).text)).toContain("browser-use engine");
	});

	it("surfaces engine errors as tool text, not throws (no chromium scenario)", async () => {
		// tabs is safe without a browser; a coordinate click without a frame must
		// fail with a typed error surfaced as text.
		const tabs = await browserBuiltinCommand.execute("tc2", { subcommand: "tabs" }, undefined, undefined, {} as never);
		expect(String((tabs.content[0] as { text?: string }).text)).toMatch(/no tabs/);
	});
});

// Controller singleton sanity: fresh controller has no tabs and unknown
// tab operations raise typed errors.
describe("browser controller (no chromium)", () => {
	it("empty state and typed errors for missing tabs", async () => {
		const controller = getBrowserController();
		const state = controller.getState();
		expect(state.available).toBe(false);
		expect(state.tabs).toEqual([]);
		await expect(controller.use("t99")).rejects.toMatchObject({ code: "unknown_tab" });
		await expect(controller.snapshot()).rejects.toMatchObject({ code: "no_active_tab" });
	});

	it("closing an unknown tab id reports unknown_tab instead of a fake success", async () => {
		const controller = getBrowserController();
		await expect(controller.close("t99")).rejects.toMatchObject({ code: "unknown_tab" });
	});
});
