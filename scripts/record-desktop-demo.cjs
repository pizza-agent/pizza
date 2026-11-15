#!/usr/bin/env node

/**
 * Record the running native Pizza window on macOS, with actual user interactions.
 * Start the latest DEV desktop, select a public demo workspace and obtain its
 * screen-capture window ID from macOS CoreGraphics metadata. Do not record personal content.
 *
 * Usage: node scripts/record-desktop-demo.cjs <window-id> <seconds> /outside/repo/demo.mov
 * This only captures the window; operate Pizza normally while it records.
 * Encode an MP4 with FFmpeg and upload it to Cloudflare R2 (see infra/website/README.md).
 */
const { spawn } = require("node:child_process");
const { mkdirSync, realpathSync } = require("node:fs");
const { dirname, isAbsolute, relative, resolve, sep } = require("node:path");

const [windowId, seconds, output] = process.argv.slice(2);
if (process.platform !== "darwin" || !/^\d+$/.test(windowId ?? "") ||
    !/^\d+$/.test(seconds ?? "") || Number(seconds) < 1 || Number(seconds) > 600 ||
    !output || !isAbsolute(output) || !output.endsWith(".mov")) {
  console.error("Usage (macOS): node scripts/record-desktop-demo.cjs <window-id> <1-600 seconds> /outside/repo/demo.mov");
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
const root = realpathSync(resolve(__dirname, ".."));
const parent = realpathSync(dirname(output));
const withinRepo = relative(root, parent);
if (withinRepo === "" || (!withinRepo.startsWith(`..${sep}`) && withinRepo !== ".." && !isAbsolute(withinRepo))) {
  console.error("Save recordings outside the Git checkout. Publish them through Cloudflare R2.");
  process.exit(1);
}
const recording = spawn("/usr/sbin/screencapture", ["-v", `-l${windowId}`, `-V${seconds}`, "-k", "-x", output], { stdio: "inherit" });
recording.on("error", error => { console.error(error.message); process.exitCode = 1; });
recording.on("exit", code => { process.exitCode = code ?? 1; });
