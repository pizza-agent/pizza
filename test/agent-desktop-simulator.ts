/**
 * In-process stand-in for the agent-desktop CLI.
 *
 * It speaks the same JSON envelope the real CLI prints (one object on stdout)
 * and keeps session ids, snapshot refs, and permission state. It does not
 * touch a real desktop. Pizza's `_desktop` command is pointed at `runner`.
 */

import type { DesktopRunOptions, DesktopRunResult, DesktopRunner } from "../src/builtin-extensions/agent-desktop/runner.js";

export interface SimulatedElement {
	role: string;
	name?: string;
	value?: string;
	children?: SimulatedElement[];
}

export interface SimulatedApp {
	name: string;
	elements: SimulatedElement[];
}

export interface SimulatorCall {
	args: string[];
	cwd: string;
	input?: string;
}

export interface AgentDesktopSimulator {
	runner: DesktopRunner;
	calls: SimulatorCall[];
	/** Mark every session ended so the next command must start a new one. */
	expireSessions(): void;
	/** Make a named control disappear so the next action on its ref is STALE_REF. */
	dropElement(app: string, name: string): void;
	sessionIds(): string[];
}

interface StoredRef {
	app: string;
	name?: string;
	role: string;
	stale: boolean;
}

interface SimSession {
	id: string;
	ended: boolean;
	snapshots: Map<string, Map<string, StoredRef>>;
}

const DEFAULT_APPS: SimulatedApp[] = [
	{
		name: "Notes",
		elements: [
			{ role: "button", name: "Save" },
			{ role: "textfield", name: "Password", value: "s3cret-token" },
		],
	},
	{
		name: "Mail",
		elements: [
			{ role: "button", name: "Send" },
			{ role: "button", name: "Pay" },
			{ role: "button", name: "Delete" },
			{ role: "button", name: "Account settings" },
			{ role: "menuitem", name: "Quit Mail" },
		],
	},
	{
		name: "Safari",
		elements: [
			{ role: "webarea", name: "Page" },
			{ role: "menuitem", name: "New Window" },
		],
	},
];

function envelope(command: string, data: unknown, ok = true): DesktopRunResult {
	const body = ok
		? { version: "sim", ok: true, command, data }
		: { version: "sim", ok: false, command, error: data };
	return { code: ok ? 0 : 1, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
}

function flag(args: string[], name: string): string | undefined {
	const exact = `--${name}`;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === exact) return args[i + 1];
		if (token.startsWith(`${exact}=`)) return token.slice(exact.length + 1);
	}
	return undefined;
}

function positionals(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--") continue;
		if (token.startsWith("--")) {
			if (!token.includes("=")) i++;
			continue;
		}
		out.push(token);
	}
	return out;
}

function assignTree(nodes: SimulatedElement[], snapshotId: string, app: string, store: Map<string, StoredRef>, counter = { n: 0 }): unknown[] {
	return nodes.map((node) => {
		counter.n += 1;
		const ref = `@${snapshotId}:e${counter.n}`;
		store.set(ref, { app, name: node.name, role: node.role, stale: false });
		return {
			role: node.role,
			name: node.name,
			value: node.value,
			ref_id: ref,
			children: node.children ? assignTree(node.children, snapshotId, app, store, counter) : undefined,
		};
	});
}

export function createAgentDesktopSimulator(options?: {
	accessibility?: "granted" | "denied";
	screenRecording?: "granted" | "denied" | "not_required";
	installed?: boolean;
	apps?: SimulatedApp[];
}): AgentDesktopSimulator {
	const calls: SimulatorCall[] = [];
	let installed = options?.installed !== false;
	const accessibility = options?.accessibility ?? "granted";
	const screenRecording = options?.screenRecording ?? "granted";
	const apps = options?.apps ?? DEFAULT_APPS;
	const sessions = new Map<string, SimSession>();
	let sessionCounter = 0;
	let snapshotCounter = 0;

	function missing(): DesktopRunResult {
		return { code: 127, stdout: "", stderr: "agent-desktop: command not found" };
	}

	function sessionFor(command: string, args: string[]): { error: DesktopRunResult } | { session: SimSession | undefined } {
		const id = flag(args, "session");
		if (!id) return { session: undefined };
		const session = sessions.get(id);
		if (!session) {
			return {
				error: envelope(command, {
					code: "INVALID_ARGS",
					message: `Unknown session '${id}'`,
					details: { kind: "session_missing" },
					disposition: { delivery: "not_delivered", retry: "safe" },
				}, false),
			};
		}
		if (session.ended) {
			return {
				error: envelope(command, {
					code: "INVALID_ARGS",
					message: `Session '${id}' has ended`,
					details: { kind: "session_ended", session_id: id },
					disposition: { delivery: "not_delivered", retry: "safe" },
				}, false),
			};
		}
		return { session };
	}

	const runner: DesktopRunner = async (args: string[], runOptions: DesktopRunOptions): Promise<DesktopRunResult> => {
		calls.push({ args: [...args], cwd: runOptions.cwd, input: runOptions.input });
		if (!installed) return missing();
		const command = args[0] ?? "";
		const rest = args.slice(1);
		if (command === "permissions") {
			return envelope("permissions", {
				accessibility: { state: accessibility },
				screen_recording: { state: screenRecording },
			});
		}
		if (command === "version") {
			return envelope("version", { version: "0.0.0-sim", os: "sim", target: "sim" });
		}
		if (command === "status") {
			return envelope("status", {
				platform: "sim",
				permissions: {
					accessibility: { state: accessibility },
					screen_recording: { state: screenRecording },
				},
				state_root: "/sim/agent-desktop",
				supported_surfaces: ["window", "menu", "menubar"],
			});
		}
		if (command === "session" && rest[0] === "start") {
			sessionCounter += 1;
			const id = `run-sim-${sessionCounter}`;
			sessions.set(id, { id, ended: false, snapshots: new Map() });
			return envelope("session", { session_id: id, name: flag(rest, "name") ?? "" });
		}
		const resolved = sessionFor(command, rest);
		if ("error" in resolved) return resolved.error;
		const session = resolved.session;
		if (command === "snapshot" || command === "find") {
			const appName = flag(rest, "app") ?? "Notes";
			const app = apps.find((item) => item.name.toLowerCase() === appName.toLowerCase());
			if (!app) {
				return envelope(command, { code: "APP_NOT_FOUND", message: `No app named ${appName}`, disposition: { delivery: "not_delivered", retry: "safe" } }, false);
			}
			const surface = flag(rest, "surface");
			const nodes = surface && /^(menubar|menu|dock|menu-bar-extras)$/i.test(surface)
				? app.elements.filter((element) => element.role === "menuitem")
				: app.elements.filter((element) => element.role !== "menuitem");
			snapshotCounter += 1;
			const snapshotId = `s${snapshotCounter}`;
			const stored = new Map<string, StoredRef>();
			const tree = { role: "window", name: app.name, children: assignTree(nodes, snapshotId, app.name, stored) };
			session?.snapshots.set(snapshotId, stored);
			return envelope(command, {
				app: app.name,
				snapshot_id: snapshotId,
				ref_count: stored.size,
				complete: true,
				tree,
			});
		}
		const ref = rest.find((token) => token.startsWith("@"));
		if (ref && session) {
			const snapshotId = /^@([A-Za-z0-9]+):e\d+$/.exec(ref)?.[1];
			const stored = snapshotId ? session.snapshots.get(snapshotId) : undefined;
			if (!stored) {
				return envelope(command, {
					code: "SNAPSHOT_NOT_FOUND",
					message: `Snapshot '${snapshotId ?? ""}' not found`,
					disposition: { delivery: "not_delivered", retry: "safe" },
				}, false);
			}
			const element = stored.get(ref);
			if (!element || element.stale) {
				return envelope(command, {
					code: "STALE_REF",
					message: `Ref ${ref} is stale`,
					disposition: { delivery: "not_delivered", retry: "safe" },
				}, false);
			}
		}
		if (command === "type" || command === "set-value" || command === "clipboard-set") {
			return envelope(command, {
				action: command,
				post_state: { value: runOptions.input ?? positionals(rest).at(-1) ?? "" },
				disposition: { delivery: "delivered_verified", retry: "unsafe" },
			});
		}
		if (command === "click" || command === "press") {
			return envelope(command, {
				action: command,
				disposition: { delivery: "delivered_unverified", retry: "unsafe" },
			});
		}
		return envelope(command, { action: command });
	};

	return {
		runner,
		calls,
		expireSessions() {
			for (const session of sessions.values()) session.ended = true;
		},
		dropElement(app, name) {
			for (const session of sessions.values()) {
				for (const snapshot of session.snapshots.values()) {
					for (const ref of snapshot.values()) {
						if (ref.app === app && ref.name === name) ref.stale = true;
					}
				}
			}
		},
		sessionIds: () => [...sessions.keys()],
	};
}
