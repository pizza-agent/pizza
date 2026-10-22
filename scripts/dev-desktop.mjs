import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const socketPath = process.platform === "win32"
	? "\\\\.\\pipe\\gateway-dev"
	: join(homedir(), ".pizza", "gateway-dev.sock");

function request(message, matches) {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		const finish = (error, value) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve(value);
		};
		const timer = setTimeout(() => finish(new Error("gateway request timed out")), 3000);
		socket.on("error", error => finish(error));
		socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
		socket.on("data", data => {
			buffer += data;
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const response = JSON.parse(line);
					if (matches(response)) finish(null, response);
				} catch (error) { finish(error); }
			}
		});
	});
}

let revision = 0;
let pendingReload = false;
let checking = false;
async function reloadWhenIdle() {
	if (!pendingReload || checking) return;
	checking = true;
	const currentRevision = revision;
	try {
		const status = await request({ type: "status" }, r => r.type === "status_result");
		if (status.agents.some(agent => agent.busy || agent.queueLength)) return;
		// Desktop prompts do not set the gateway's tell-only busy flag.
		for (const agent of status.agents) {
			const id = `dev-reload-${currentRevision}-${agent.cwd}`;
			const response = await request({ type: "rpc", workspace: agent.cwd, frame: { id, type: "get_state" } }, r => r.frame?.id === id);
			if (!response.frame.success || response.frame.data?.isStreaming || response.frame.data?.isCompacting || response.frame.data?.pendingMessageCount) return;
		}
		if (currentRevision !== revision) return;
		await request({ type: "shutdown" }, r => r.type === "shutdown_ok");
		pendingReload = false;
		console.log("[desktop-dev] Backend rebuilt; gateway reconnect will load the new code.");
	} catch (error) {
		// No gateway yet: the first desktop connection loads the latest build.
		if (error.code === "ENOENT" || error.code === "ECONNREFUSED") pendingReload = false;
	} finally { checking = false; }
}

const compiler = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput", "--pretty", "false"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
let firstCompilation = true;
let compilerOutput = "";
compiler.stdout.on("data", data => {
	process.stdout.write(data);
	compilerOutput += data;
	let newline;
	while ((newline = compilerOutput.indexOf("\n")) >= 0) {
		const line = compilerOutput.slice(0, newline);
		compilerOutput = compilerOutput.slice(newline + 1);
		if (!line.includes("Found 0 errors. Watching for file changes.")) continue;
		if (firstCompilation) { firstCompilation = false; continue; }
		revision++;
		pendingReload = true;
		console.log("[desktop-dev] Backend compiled; waiting for idle before reload.");
		void reloadWhenIdle();
	}
});
const config = JSON.parse(readFileSync(join(root, "apps/desktop/tauri.conf.json"), "utf8"));
const devConfig = { app: { windows: config.app.windows.map(window => ({ ...window, title: "Pizza · Dev" })) } };
const desktopEnv = { ...process.env };
delete desktopEnv.PIZZA_BIN;
const desktop = spawn("cargo", ["tauri", "dev", "--config", JSON.stringify(devConfig)], { cwd: join(root, "apps/desktop"), env: desktopEnv, stdio: "inherit" });
const reloadTimer = setInterval(() => void reloadWhenIdle(), 2000);
let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	clearInterval(reloadTimer);
	compiler.kill();
	desktop.kill();
	process.exitCode = code;
}
desktop.on("exit", code => stop(code ?? 0));
compiler.on("exit", code => { if (!stopping) stop(code || 1); });
for (const child of [compiler, desktop]) child.on("error", error => { console.error(error); stop(1); });
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
