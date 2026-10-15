import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Frees the vite dev port before startup.
 *
 * vite.config.ts sets `strictPort: true` because tauri.conf.json pins
 * devUrl to http://127.0.0.1:1420 — vite cannot fall back to another port.
 * Orphaned `tauri dev` / vite processes survive closed terminals and keep
 * the port bound, which makes the next `dev` run fail with EADDRINUSE.
 *
 * This script kills listeners on the port, but only when they look like a
 * leftover vite/tauri/bun dev process from this repo. Anything else holding
 * the port is reported so the user can decide.
 */

const PORT = 1420;
const WEB_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAFE_PATTERN = /vite|tauri|pizza|bun run dev|npm run dev/i;

function listeners() {
	if (process.platform === "win32") {
		const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
		const pids = new Set();
		for (const line of out.split("\n")) {
			const cols = line.trim().split(/\s+/);
			if (cols[1]?.endsWith(`:${PORT}`) && cols[3] === "LISTENING") pids.add(cols[4]);
		}
		return [...pids].map((pid) => ({ pid: Number(pid), cmd: windowsCmdline(pid) }));
	}
	let out;
	try {
		out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
	} catch {
		return []; // lsof exits non-zero when nothing listens
	}
	return out
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((pid) => ({
			pid: Number(pid),
			cmd: execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim(),
		}));
}

function windowsCmdline(pid) {
	try {
		return execFileSync(
			"powershell",
			["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
			{ encoding: "utf8" },
		).trim();
	} catch {
		return "";
	}
}

function kill(pid) {
	if (process.platform === "win32") {
		execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
	} else {
		try {
			process.kill(pid);
		} catch {
			/* already gone */
		}
	}
}

const stale = [];
const foreign = [];
for (const l of listeners()) {
	const inRepo = l.cmd.includes(WEB_DIR) || l.cmd.includes("apps/web");
	if (inRepo || SAFE_PATTERN.test(l.cmd)) stale.push(l);
	else foreign.push(l);
}

for (const l of stale) {
	console.log(`[free-port] killing stale dev process on :${PORT} (pid ${l.pid}): ${l.cmd}`);
	kill(l.pid);
}

if (foreign.length > 0) {
	for (const l of foreign) {
		console.error(`[free-port] :${PORT} is held by an unrelated process (pid ${l.pid}): ${l.cmd}`);
	}
	console.error(`[free-port] refusing to kill it — free the port manually or change server.port in vite.config.ts`);
	process.exit(1);
}
