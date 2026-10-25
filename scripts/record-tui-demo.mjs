#!/usr/bin/env node

/**
 * Record a scripted Pizza TUI session to an asciicast v2 file.
 *
 * Uses node-pty (already a repo dependency) to spawn `pizza`, type a prompt,
 * and record the start of the agent's turn.
 *
 * Usage:
 *   node scripts/record-tui-demo.mjs [output.cast]
 *
 * Convert the result to a GIF with agg (https://github.com/asciinema/agg):
 *   agg --idle-time-limit 2 output/demo-tui.cast resources/demo-tui.gif
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = process.argv[2] ?? join(root, "output", "demo-tui.cast");
const demoDir = process.env.PIZZA_DEMO_DIR ?? "/tmp/pizza-demo";

const COLS = 100;
const ROWS = 30;
const TYPE_MS = 55;

const PROMPT = "write fib.py that prints the first 20 fibonacci numbers, then run it";

const events = [];
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
let transcript = "";
let waiters = [];

const term = pty.spawn("pizza", [], {
	name: "xterm-256color",
	cols: COLS,
	rows: ROWS,
	cwd: demoDir,
	env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});

term.onData((data) => {
	events.push([now(), "o", data]);
	transcript += data;
	for (const w of waiters.splice(0)) w.check();
});
term.onExit(({ exitCode }) => {
	console.log(`\npty exited (${exitCode})`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(pattern, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiters = waiters.filter((w) => w !== entry);
			resolve(false);
		}, timeoutMs);
		const entry = {
			check() {
				if (pattern.test(transcript)) {
					clearTimeout(timer);
					resolve(true);
				}
			},
		};
		waiters.push(entry);
		entry.check();
	});
}

/** Wait until the transcript has been silent for `idleMs` (min `minMs`, max `maxMs`). */
async function waitForIdle(idleMs, minMs, maxMs) {
	const start = Date.now();
	let lastLen = -1;
	let lastChange = Date.now();
	while (Date.now() - start < maxMs) {
		await sleep(250);
		if (transcript.length !== lastLen) {
			lastLen = transcript.length;
			lastChange = Date.now();
		}
		if (Date.now() - start >= minMs && Date.now() - lastChange >= idleMs) return;
	}
}

async function type(text) {
	for (const ch of text) {
		term.write(ch);
		await sleep(TYPE_MS);
	}
}

async function main() {
	mkdirSync(dirname(outFile), { recursive: true });
	mkdirSync(demoDir, { recursive: true });

	console.log("waiting for TUI to boot...");
	await waitFor(/Type|Ready|message/i, 15000);
	await sleep(2000);

	console.log("typing prompt...");
	await type(PROMPT);
	await sleep(400);
	term.write("\r");

	console.log("waiting for agent turn...");
	await waitForIdle(4000, 10000, 40000);
	await sleep(1500);

	term.kill();

	const header = {
		version: 2,
		width: COLS,
		height: ROWS,
		timestamp: Math.floor(t0 / 1000),
		title: "Pizza TUI demo",
		env: { TERM: "xterm-256color" },
	};
	const body = events.map((e) => JSON.stringify(e)).join("\n");
	writeFileSync(outFile, `${JSON.stringify(header)}\n${body}\n`);
	console.log(`wrote ${events.length} events (${now().toFixed(1)}s) -> ${outFile}`);
}

main().catch((err) => {
	console.error(err);
	term.kill();
	process.exit(1);
});
