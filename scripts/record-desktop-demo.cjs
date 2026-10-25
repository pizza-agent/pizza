#!/usr/bin/env node

/**
 * Record a scripted Pizza desktop (web) session to a video via Playwright.
 *
 * Prereqs:
 *   1. `npm run dev` inside apps/web (vite + pizza rpc bridge on :1420)
 *   2. Google Chrome installed (uses channel "chrome"; no playwright download needed)
 *
 * Usage:
 *   node scripts/record-desktop-demo.cjs [outDir]
 *
 * Convert the .webm to a GIF with ffmpeg:
 *   ffmpeg -i video.webm -vf "fps=15,scale=1280:-1:flags=lanczos,palettegen" pal.png
 *   ffmpeg -i video.webm -i pal.png -lavfi "fps=15,scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse" demo-desktop.gif
 */

const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.PIZZA_WEB_URL ?? "http://127.0.0.1:1420/";
const outDir = process.argv[2] ?? path.join(__dirname, "..", "output", "desktop-video");
const PROMPT = "write a python script that prints the first 20 fibonacci numbers, then run it";

(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
	});
	const page = await context.newPage();

	console.log("loading", BASE);
	await page.goto(BASE);
	const composer = page.locator("textarea").first();
	await composer.waitFor({ state: "visible", timeout: 30000 });
	await page.waitForTimeout(2500);

	console.log("typing prompt...");
	await composer.click();
	await composer.pressSequentially(PROMPT, { delay: 55 });
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");

	console.log("waiting for agent turn...");
	// Fixed wait: safe-mode is off so tools auto-run; the task takes ~15-30s.
	await page.waitForTimeout(40000);

	console.log("opening History panel...");
	try {
		await page.getByText("History", { exact: true }).first().click({ timeout: 5000 });
	} catch {
		console.log("History tab not found, skipping");
	}
	await page.waitForTimeout(3500);

	await context.close(); // flushes the video file
	await browser.close();

	const videos = fs.readdirSync(outDir).filter((f) => f.endsWith(".webm"));
	console.log("video(s):", videos.map((v) => path.join(outDir, v)).join("\n"));
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
