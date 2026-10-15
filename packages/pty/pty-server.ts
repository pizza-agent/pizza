/**
 * PTY-over-WebSocket server.
 *
 * Hosts interactive pseudo-terminal sessions (via node-pty) reachable over a
 * local WebSocket. This is the "real terminal" backend used by the web/desktop
 * Terminal pane (xterm.js on the client).
 *
 * Protocol (text frames of JSON objects):
 *   client -> server
 *     { type: "spawn",  cwd?: string, cols?: number, rows?: number }
 *         Spawns a shell. May be omitted to use defaults (process.cwd()).
 *     { type: "input",  data: string }
 *     { type: "resize", cols: number, rows: number }
 *     { type: "kill" }
 *   server -> client
 *     { type: "ready" }
 *     { type: "output", data: string }
 *     { type: "exit",   exitCode: number }
 *     { type: "error",  message: string }
 *
 * node-pty is loaded lazily so a missing/incompatible native build (e.g. the
 * Bun-compiled binary) degrades gracefully instead of crashing the sidecar.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { spawnMinimalPty, resolveNativeDir, type MinimalPty } from "./unix-pty.js";

/**
 * Backend-agnostic PTY process handle. Both node-pty (dev/Node) and the
 * minimal fallback (Bun-compiled binary) conform to this shape.
 */
interface PtyProc {
	onData(cb: (data: string) => void): void;
	onExit(cb: (exitCode: number) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

interface PtySession {
	proc: PtyProc;
}

/**
 * Spawn a PTY. Tries the real `node-pty` package first (works under Node and in
 * dev). If that import fails — the common case inside a `bun build --compile`
 * standalone binary, which strips node_modules — falls back to the minimal
 * loader that requires node-pty's prebuilt `pty.node` by absolute path.
 */
async function spawnPty(
	file: string,
	args: string[],
	opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
): Promise<PtyProc> {
	try {
		const pty = await import("node-pty");
		const proc = pty.spawn(file, args, {
			name: "xterm-256color",
			cols: opts.cols,
			rows: opts.rows,
			cwd: opts.cwd,
			env: opts.env,
		});
		return {
			onData: (cb) => proc.onData(cb),
			onExit: (cb) => proc.onExit((e) => cb(e.exitCode)),
			write: (d) => proc.write(d),
			resize: (c, r) => proc.resize(c, r),
			kill: () => proc.kill(),
		};
	} catch {
		const nativeDir = resolveNativeDir(process.platform, process.arch);
		const proc: MinimalPty = spawnMinimalPty(file, args, {
			cwd: opts.cwd,
			cols: opts.cols,
			rows: opts.rows,
			env: opts.env,
			nativeDir,
		});
		return {
			onData: (cb) => proc.onData(cb),
			onExit: (cb) => proc.onExit(cb),
			write: (d) => proc.write(d),
			resize: (c, r) => proc.resize(c, r),
			kill: () => proc.kill(),
		};
	}
}


export interface PtyServerOptions {
	host?: string;
	port?: number;
	/** Default working directory for spawned shells. */
	cwd?: string;
}

export interface PtyServer {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

export async function startPtyServer(options: PtyServerOptions = {}): Promise<PtyServer> {
	const host = options.host ?? "127.0.0.1";
	const defaultCwd = options.cwd ?? process.cwd();

	const wss = new WebSocketServer({ host, port: options.port ?? 0 });
	await new Promise<void>((resolve) => wss.on("listening", resolve));

	const address = wss.address();
	const port = typeof address === "object" && address ? address.port : 0;

	wss.on("connection", (ws: WebSocket) => {
		const session: { pty: PtySession | null } = { pty: null };

		const send = (obj: Record<string, unknown>): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
		};

		const spawn = async (opts: {
			cwd?: string;
			cols?: number;
			rows?: number;
		}): Promise<void> => {
			if (session.pty) return;
			const cols = opts.cols && opts.cols > 0 ? opts.cols : 80;
			const rows = opts.rows && opts.rows > 0 ? opts.rows : 24;
			const cwd = opts.cwd?.trim() ? opts.cwd : defaultCwd;
			try {
				const proc = await spawnPty(process.env.SHELL || "sh", [], {
					cols,
					rows,
					cwd,
					env: process.env as Record<string, string>,
				});
				proc.onData((data: string) => send({ type: "output", data }));
				proc.onExit((exitCode: number) => {
					if (exitCode === -1) {
						// Fallback sentinel: the PTY socket closed before the shell
						// produced any output — almost always means spawn-helper could
						// not exec the shell. Surface a hint; full cause is in the log.
						send({ type: "output", data: "\r\n\x1b[31mTerminal failed to start the shell. See /tmp/pizza-pty.log\x1b[0m\r\n" });
					}
					send({ type: "exit", exitCode });
					try { ws.close(); } catch { /* ignore */ }
				});
				session.pty = { proc };
				send({ type: "ready" });
			} catch (err) {
				send({ type: "error", message: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		};

		ws.on("message", (raw) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				send({ type: "error", message: "invalid JSON frame" });
				return;
			}
			switch (msg.type) {
				case "spawn":
					void spawn({
						cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
						cols: typeof msg.cols === "number" ? msg.cols : undefined,
						rows: typeof msg.rows === "number" ? msg.rows : undefined,
					});
					break;
				case "input":
					if (session.pty && typeof msg.data === "string") session.pty.proc.write(msg.data);
					break;
				case "resize":
					if (session.pty && typeof msg.cols === "number" && typeof msg.rows === "number") {
						try { session.pty.proc.resize(msg.cols, msg.rows); } catch { /* ignore */ }
					}
					break;
				case "kill":
					if (session.pty) { try { session.pty.proc.kill(); } catch { /* ignore */ } }
					break;
				default:
					send({ type: "error", message: `unknown message type: ${String(msg.type)}` });
			}
		});

		ws.on("close", () => {
			if (session.pty) { try { session.pty.proc.kill(); } catch { /* ignore */ } session.pty = null; }
		});

		ws.on("error", () => { /* swallow; socket torn down */ });
	});

	return {
		port,
		url: `ws://${host}:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				wss.close(() => resolve());
			}),
	};
}
