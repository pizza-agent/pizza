import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
const SAFE_PATTERN = /(?:^|[\\/\s"'])(?:vite(?:\.js)?|tauri)(?=$|[\\/\s"'])|(?:^|\s)(?:bun|npm)\s+run\s+dev(?:\s|$)/i;

export function isRepoDevProcess({ cmd, cwd }, webDir = WEB_DIR, platform = process.platform) {
	const paths = platform === "win32" ? path.win32 : path.posix;
	const normalize = (value) => platform === "win32" ? paths.resolve(value).toLowerCase() : paths.resolve(value);
	const root = normalize(webDir);
	if (!SAFE_PATTERN.test(cmd)) return false;
	if (cwd) return normalize(cwd) === root;
	// Require an absolute argument inside this exact checkout. Generic names
	// and relative apps/web paths also occur in unrelated repositories.
	const args = cmd.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
	return args.some((arg) => {
		const value = arg.replace(/^["']|["']$/g, "");
		return paths.isAbsolute(value) && normalize(value).startsWith(root + paths.sep);
	});
}

function processCwd(pid) {
	try {
		const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
		return out.split("\n").find((line) => line.startsWith("n"))?.slice(1);
	} catch {
		return undefined;
	}
}

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
	} catch (error) {
		if (error.status === 1 && !error.stdout?.trim()) return [];
		throw error;
	}
	return out
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((pid) => ({
			pid: Number(pid),
			cmd: unixCmdline(pid),
			cwd: processCwd(pid),
		}));
}

function unixCmdline(pid) {
	try {
		return execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
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

export async function freePort() {
	const stale = [];
	const foreign = [];
	for (const listener of listeners()) {
		if (isRepoDevProcess(listener)) stale.push(listener);
		else foreign.push(listener);
	}

	if (foreign.length > 0) {
		for (const listener of foreign) {
			console.error(`[free-port] :${PORT} is held by an unrelated process (pid ${listener.pid}): ${listener.cmd}`);
		}
		throw new Error(`[free-port] refusing to kill it — free the port manually or change server.port in vite.config.ts`);
	}

	for (const listener of stale) {
		console.log(`[free-port] killing stale dev process on :${PORT} (pid ${listener.pid}): ${listener.cmd}`);
		kill(listener.pid);
	}
	// SIGTERM is asynchronous. Do not race Vite against the old listener's
	// shutdown; fail visibly if it ignores termination or the port is taken.
	if (stale.length > 0) {
		const deadline = Date.now() + 2000;
		while (listeners().length > 0) {
			if (Date.now() >= deadline) throw new Error(`[free-port] :${PORT} is still occupied after termination`);
			await delay(50);
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await freePort();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
