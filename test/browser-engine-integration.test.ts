/**
 * Real-browser integration test for the browser-use engine. Skipped
 * automatically when no managed Chromium can be resolved (CI has none) —
 * runs wherever Chrome/Chromium or a Chrome-for-Testing install exists.
 *
 * Covers the M1 acceptance path: open → snapshot → click → type →
 * screenshot, the navigation policy against a live page, and the frame
 * channel (token handshake, binary frames, single-use token).
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { resolveChromium } from "../src/core/browser/chromium.js";
import { BrowserFrameServer } from "../src/core/browser/frame-server.js";
import { BrowserController, getBrowserController } from "../src/core/browser/controller.js";

const chromium = await resolveChromium().catch(() => undefined);

describe.skipIf(!chromium)("browser engine integration (real chromium)", () => {
	let server: http.Server;
	let baseUrl: string;
	let controller: BrowserController;
	let frameServer: BrowserFrameServer | undefined;
	const auditLog: Array<{ type: string; payload: Record<string, unknown> }> = [];

	const pageHtml = `<!doctype html><html><head><title>Integration</title></head><body>
		<h1>Integration Page</h1>
		<input id="q" placeholder="type here" aria-label="query">
		<button id="go" onclick="document.getElementById('out').textContent=document.getElementById('q').value + '!'">Go</button>
		<a id="nav" href="/next">next page</a>
		<div id="out"></div>
		<div id="next-marker" style="display:none">next page loaded</div>
		<div id="spinner" style="width:16px;height:16px;background:#39f;animation:spin 1s linear infinite"></div>
		<style>@keyframes spin { to { transform: rotate(360deg); } }</style>
		</body></html>`;
	// Any response must keep the compositor producing frames (the spinner
	// animation): headless Chromium — notably on Windows — may never emit an
	// initial screencast frame for a fully static page, so tests that wait
	// for a binary frame would hang.

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			if (req.url?.startsWith("/next")) {
				res.end(`<!doctype html><html><body><div id="next-marker">next page loaded</div><div id="spinner" style="width:16px;height:16px;background:#39f;animation:spin 1s linear infinite"></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style></body></html>`);
				return;
			}
			res.end(pageHtml);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

		controller = getBrowserController();
		controller.setHostHooks({
			emitAuditEvent: (type, payload) => auditLog.push({ type, payload: payload as Record<string, unknown> }),
		});
	}, 30_000);

	afterAll(async () => {
		await controller.emergencyStop().catch(() => {});
		await frameServer?.close().catch(() => {});
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}, 30_000);

	it("opens a local page and produces a ref-bearing ARIA snapshot", async () => {
		const info = await controller.open(baseUrl, { source: "test" });
		expect(info.url).toBe(baseUrl);
		const snapshot = await controller.snapshot();
		expect(snapshot).toContain("[ref=e");
		expect(snapshot).toContain("textbox");
		expect(snapshot).toContain('button "Go"');
	}, 60_000);

	it("types into an input and clicks a button by ref", async () => {
		const snapshot = await controller.snapshot();
		const inputRef = /textbox[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
		const buttonRef = /button "Go"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
		expect(inputRef).toBeDefined();
		expect(buttonRef).toBeDefined();

		await controller.type({ ref: inputRef!, text: "hello pizza" });
		await controller.click({ ref: buttonRef! });
		// Snapshot cache was invalidated by the actions — this is a fresh read.
		const after = await controller.snapshot();
		expect(after).toContain("hello pizza!");
	}, 60_000);

	it("stale-coordinate clicks are rejected (frame epoch validation)", async () => {
		await expect(controller.click({ x: 10, y: 10 })).rejects.toMatchObject({ code: "stale_frame" });
		await expect(controller.click({ x: 10, y: 10, frameId: 1 })).rejects.toMatchObject({ code: "stale_frame" });
	});

	it("unknown refs fail fast with stale_ref instead of burning the action timeout", async () => {
		await controller.snapshot(); // prime the snapshot cache
		const started = Date.now();
		await expect(controller.click({ ref: "e99999" })).rejects.toMatchObject({ code: "stale_ref" });
		expect(Date.now() - started).toBeLessThan(1500);
		await expect(controller.type({ ref: "e88888", text: "x" })).rejects.toMatchObject({ code: "stale_ref" });
	});

	it("takes a PNG screenshot", async () => {
		const png = await controller.screenshot();
		expect(png.length).toBeGreaterThan(1000);
		expect(png[0]).toBe(0x89);
		expect(png[1]).toBe(0x50);
	}, 60_000);

	it("blocks non-http navigation on a live tab", async () => {
		await expect(controller.navigate(undefined, "file:///etc/passwd", "test")).rejects.toMatchObject({
			code: "navigation_blocked",
		});
	});

	it("follows same-origin links via ref clicks (in-page navigation invalidates refs)", async () => {
		let snapshot = await controller.snapshot();
		const linkRef = /link "next page"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
		expect(linkRef).toBeDefined();
		await controller.click({ ref: linkRef! });
		snapshot = await controller.snapshot();
		expect(snapshot).toContain("next page loaded");
	}, 60_000);

	it("mirrors frames over the token-authenticated websocket and enforces single-use tokens", async () => {
		frameServer ??= await BrowserFrameServer.start(controller);
		const creds = frameServer.getCredentials();

		controller.setPanelVisible(true);
		// Trigger visual activity so a frame is produced.
		await controller.scroll({ direction: "down", amount: 100 }).catch(() => {});

		const ws = new WebSocket(`ws://127.0.0.1:${creds.wsPort}/?token=${creds.token}`);
		ws.binaryType = "arraybuffer";
		let sawHello = false;
		let sawMeta = false;
		let sawBinary = false;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no binary frame within timeout")), 15_000);
			ws.on("message", (data, isBinary) => {
				if (isBinary) {
					sawBinary = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				const message = JSON.parse(String(data)) as { type: string };
				if (message.type === "hello") sawHello = true;
				if (message.type === "frame_meta") sawMeta = true;
			});
			ws.on("error", (e) => reject(e));
		});
		ws.close();
		expect(sawHello).toBe(true);
		expect(sawMeta).toBe(true);
		expect(sawBinary).toBe(true);
		controller.setPanelVisible(false);

		// Token replay must be rejected with our handshake close code.
		const replay = new WebSocket(`ws://127.0.0.1:${creds.wsPort}/?token=${creds.token}`);
		const replayCode = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("replay socket never closed")), 5000);
			replay.on("close", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			replay.on("error", (e) => reject(e));
		});
		expect(replayCode).toBe(4401);

		// Forged origin is rejected before the token even matters.
		const fresh = frameServer.getCredentials();
		const forged = new WebSocket(`ws://127.0.0.1:${fresh.wsPort}/?token=${fresh.token}`, {
			headers: { Origin: "https://evil.example.com" },
		});
		const forgedCode = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("forged socket never closed")), 5000);
			forged.on("close", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			forged.on("error", (e) => reject(e));
		});
		expect(forgedCode).toBe(4403);
	}, 60_000);

	it("emits whitelisted audit events (no page content)", async () => {
		expect(auditLog.length).toBeGreaterThan(0);
		const serialized = JSON.stringify(auditLog);
		expect(serialized).toContain("BROWSER_TAB_OPENED");
		expect(serialized).toContain("BROWSER_NAVIGATED");
		expect(serialized).toContain("BROWSER_ACTION");
		// Whitelist: snapshots/page content must never appear in audit payloads.
		expect(serialized).not.toContain("textbox");
		expect(serialized).not.toContain("hello pizza");
	});

	it("starts mirroring when the first tab opens after the panel is already visible", async () => {
		// Regression: the panel opens before any tab exists; the first tab
		// opening later must start pushing frames without another activation.
		controller.setPanelVisible(true);
		await controller.emergencyStop(); // clean slate: no tabs, approvals reset
		controller.setPanelVisible(true);

		frameServer ??= await BrowserFrameServer.start(controller);
		const creds = frameServer.getCredentials();
		const ws = new WebSocket(`ws://127.0.0.1:${creds.wsPort}/?token=${creds.token}`);
		ws.binaryType = "arraybuffer";
		const sawFrame = new Promise<boolean>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no frame after first tab opened")), 20_000);
			ws.on("message", (_data, isBinary) => {
				if (isBinary) {
					clearTimeout(timer);
					resolve(true);
				}
			});
			ws.on("error", (e) => reject(e));
		});
		// Open the first tab only after the (frame-watching) panel connected.
		await controller.open(`${baseUrl}first-open`, { source: "test" });
		expect(await sawFrame).toBe(true);
		ws.close();
	}, 60_000);

	it("emergency stop clears everything", async () => {
		await controller.emergencyStop();
		const state = controller.getState();
		expect(state.available).toBe(false);
		expect(state.tabs).toEqual([]);
	}, 30_000);
});
