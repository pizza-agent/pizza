import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDesktopExtension } from "../src/builtin-extensions/agent-desktop/index.js";
import {
	AGENT_DESKTOP_EXTENSION_ID,
	desktopBuiltinCommand,
	resetDesktopPermissionCache,
	setActiveDesktopCwd,
} from "../src/builtin-extensions/agent-desktop/cli-command.js";
import { redactDesktopCommandLine } from "../src/builtin-extensions/agent-desktop/policy.js";
import { resetDesktopSecretsForTests } from "../src/builtin-extensions/agent-desktop/secrets.js";
import { resetDesktopSessionsForTests } from "../src/builtin-extensions/agent-desktop/session.js";
import { setDesktopRunnerForTests, type DesktopRunResult } from "../src/builtin-extensions/agent-desktop/runner.js";
import {
	BUILTIN_EXTENSIONS,
	getBuiltinExtensionFactories,
} from "../src/builtin-extensions/index.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { IntentClassifier, needsRuntimeApproval } from "../src/core/intent/classifier.js";
import { redactCommandForLog } from "../src/core/tools/command-redaction.js";

interface Call {
	args: string[];
	cwd: string;
	input?: string;
}

const AUDIT_KEYS = new Set(["action", "outcome", "app", "snapshot_id", "ref", "artifact", "reason", "session_id"]);

function envelope(command: string, data: Record<string, unknown>, ok = true): DesktopRunResult {
	return {
		code: ok ? 0 : 1,
		stdout: JSON.stringify({ ok, command, ...(ok ? { data } : { error: data }) }),
		stderr: "",
	};
}

describe("agent-desktop execution layer", () => {
	let root: string;
	let agentDir: string;
	let workspaceA: string;
	let workspaceB: string;
	let calls: Call[];
	let originalCwd: string;
	const originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;

	beforeEach(() => {
		originalCwd = process.cwd();
		root = mkdtempSync(join(tmpdir(), "pizza-desktop-"));
		agentDir = join(root, "agent");
		workspaceA = join(root, "ws-a");
		workspaceB = join(root, "ws-b");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspaceA, { recursive: true });
		mkdirSync(workspaceB, { recursive: true });
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
		calls = [];
		resetDesktopSecretsForTests();
		resetDesktopSessionsForTests();
		resetDesktopPermissionCache();
		setActiveDesktopCwd(undefined);
		setDesktopRunnerForTests(async (args, options) => {
			calls.push({ args: [...args], cwd: options.cwd, input: options.input });
			if (args[0] === "permissions") {
				return envelope("permissions", {
					accessibility: { state: "granted" },
					screen_recording: { state: "granted" },
				});
			}
			if (args[0] === "session" && args[1] === "start") {
				const sessionId = options.cwd.endsWith("ws-b") ? "run-b" : "run-a";
				return envelope("session", { session_id: sessionId });
			}
			if (args[0] === "snapshot") {
				const snapshotId = options.cwd.endsWith("ws-b") ? "sb" : "sa";
				const appAt = args.indexOf("--app");
				const app = appAt >= 0 ? args[appAt + 1] : "Notes";
				const name = app === "Mail" ? "Send" : "Save";
				return envelope("snapshot", {
					snapshot_id: snapshotId,
					app,
					ref_count: 1,
					complete: true,
					tree: { role: "button", name, ref_id: `@${snapshotId}:e1`, children: [] },
				});
			}
			if (args[0] === "click") {
				return envelope("click", {
					action: "click",
					disposition: { delivery: "delivered_unverified", retry: "unsafe" },
				});
			}
			if (args[0] === "type") {
				return envelope("type", { action: "type", post_state: { value: options.input ?? "" } });
			}
			if (args[0] === "wait") {
				return envelope("wait", { matched: true });
			}
			return envelope(args[0] ?? "unknown", {});
		});
	});

	afterEach(() => {
		setDesktopRunnerForTests(undefined);
		setActiveDesktopCwd(undefined);
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env.PIZZA_CODING_AGENT_DIR;
		else process.env.PIZZA_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	function enable(cwd: string) {
		SettingsManager.create(cwd, agentDir).setBuiltinExtensionDisabled(AGENT_DESKTOP_EXTENSION_ID, false);
		setActiveDesktopCwd(cwd);
	}

	function ctx(cwd: string, threadId: string, events: Array<{ type: string; payload: Record<string, unknown> }> = []): ExtensionContext {
		return {
			cwd,
			hasUI: false,
			sessionManager: {
				eventStore: {
					append(event: { type: string; payload: Record<string, unknown> }) {
						events.push(event);
						return event;
					},
				},
				projection: {
					getDescriptor: () => ({ thread_id: threadId, session_id: "sess", workspace_id: "ws" }),
				},
			},
		} as unknown as ExtensionContext;
	}

	async function run(cwd: string, threadId: string, args: string[], events?: Array<{ type: string; payload: Record<string, unknown> }>) {
		const params = desktopBuiltinCommand.parseArguments!(args, undefined, { quoteDelimitersConsumed: 0 });
		return {
			params,
			result: await desktopBuiltinCommand.execute("call-1", params, undefined, undefined, ctx(cwd, threadId, events)),
		};
	}

	it("stays unloaded until the user enables it, and registers no second tool", async () => {
		const manager = SettingsManager.create(workspaceA, agentDir);
		expect(manager.getDisabledBuiltinExtensions().has(AGENT_DESKTOP_EXTENSION_ID)).toBe(true);
		expect(getBuiltinExtensionFactories(manager.getDisabledBuiltinExtensions()).some((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)).toBe(false);
		expect(BUILTIN_EXTENSIONS.find((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)?.enabledByDefault).toBe(false);

		process.chdir(workspaceA);
		expect(desktopBuiltinCommand.isAvailable?.()).toBe(false);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const blocked = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"], events);
		expect(blocked.result.content[0]?.text).toContain("NOT_ENABLED");
		expect(calls).toEqual([]);
		expect(events[0]?.payload.outcome).toBe("blocked");

		manager.setBuiltinExtensionDisabled(AGENT_DESKTOP_EXTENSION_ID, false);
		expect(getBuiltinExtensionFactories(manager.getDisabledBuiltinExtensions()).some((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)).toBe(true);
		setActiveDesktopCwd(workspaceA);
		expect(desktopBuiltinCommand.isAvailable?.()).toBe(true);

		const tools: string[] = [];
		const commands: string[] = [];
		const builtins: string[] = [];
		await createAgentDesktopExtension({
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
			registerCliCommand: (command: { name: string }) => builtins.push(command.name),
			on: () => undefined,
		} as never);
		expect(tools).toEqual([]);
		expect(builtins).toEqual(["_desktop"]);
		expect(commands).toContain("desktop");
	});

	it("wraps agent-desktop in one durable workspace session and returns JSON", async () => {
		enable(workspaceA);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const first = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes", "--session", "evil"], events);
		expect(first.result.content[0]?.text).toContain('"snapshot_id": "sa"');
		expect(calls.some((call) => call.args.includes("evil"))).toBe(false);
		expect(calls.filter((call) => call.args[0] === "session" && call.args[1] === "start")).toHaveLength(1);
		expect(calls.some((call) => call.args[0] === "snapshot" && call.args.includes("--session") && call.args.includes("run-a"))).toBe(true);

		calls.length = 0;
		await run(workspaceA, "thread-a", ["click", "@sa:e1"], events);
		expect(calls.filter((call) => call.args[0] === "session")).toHaveLength(0);
		expect(calls.some((call) => call.args[0] === "click" && call.args.includes("--session") && call.args.includes("run-a"))).toBe(true);
		const audit = events.find((event) => event.type === "DESKTOP_ACTION" && event.payload.action === "snapshot");
		expect(audit).toBeDefined();
		for (const key of Object.keys(audit!.payload)) expect(AUDIT_KEYS.has(key)).toBe(true);
		expect(audit!.payload).not.toHaveProperty("version");
		expect(JSON.stringify(audit!.payload)).not.toContain("tree");
	});

	it("refuses stale refs, spent snapshots, and refs from another thread", async () => {
		enable(workspaceA);
		await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		await run(workspaceA, "thread-a", ["click", "@sa:e1"]);
		const clicks = () => calls.filter((call) => call.args[0] === "click").length;
		const afterFirst = clicks();
		const second = await run(workspaceA, "thread-a", ["click", "@sa:e1"]);
		expect(second.result.content[0]?.text).toContain("STALE_REF");
		expect(clicks()).toBe(afterFirst);

		const otherThread = await run(workspaceA, "thread-b", ["click", "@sa:e1"]);
		expect(otherThread.result.content[0]?.text).toContain("STALE_REF");
		expect(clicks()).toBe(afterFirst);

		await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const invalidated = await run(workspaceA, "thread-a", ["invalidate"]);
		expect(invalidated.result.content[0]?.text).toContain("Snapshot dropped");
		const afterInvalidate = await run(workspaceA, "thread-a", ["click", "@sa:e1"]);
		expect(afterInvalidate.result.content[0]?.text).toContain("STALE_REF");
		expect(clicks()).toBe(afterFirst);
	});

	it("binds sessions and refs to the workspace", async () => {
		enable(workspaceA);
		enable(workspaceB);
		await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		await run(workspaceB, "thread-a", ["snapshot", "--app", "Notes"]);
		const starts = calls.filter((call) => call.args[0] === "session" && call.args[1] === "start");
		expect(starts.map((call) => call.cwd).sort()).toEqual([workspaceA, workspaceB].sort());
		expect(calls.some((call) => call.cwd === workspaceA && call.args.includes("run-a"))).toBe(true);
		expect(calls.some((call) => call.cwd === workspaceB && call.args.includes("run-b"))).toBe(true);

		const crossed = await run(workspaceB, "thread-a", ["click", "@sa:e1"]);
		expect(crossed.result.content[0]?.text).toContain("STALE_REF");
		expect(calls.some((call) => call.cwd === workspaceB && call.args[0] === "click" && call.args.includes("@sa:e1"))).toBe(false);
	});

	it("requires runtime approval for destructive actions even when safe mode is off", async () => {
		enable(workspaceA);
		await run(workspaceA, "thread-a", ["snapshot", "--app", "Mail"]);
		const send = desktopBuiltinCommand.parseArguments!(["click", "@sa:e1"], undefined, { quoteDelimitersConsumed: 0 });
		const sendIntent = desktopBuiltinCommand.classify!(send);
		expect(sendIntent.forceApproval).toBe(true);
		expect(send.targetNames).toContain("Send");

		const closeIntent = desktopBuiltinCommand.classify!(
			desktopBuiltinCommand.parseArguments!(["close-app", "--app", "Mail"], undefined, { quoteDelimitersConsumed: 0 }),
		);
		expect(closeIntent.forceApproval).toBe(true);

		const snapshotIntent = desktopBuiltinCommand.classify!(
			desktopBuiltinCommand.parseArguments!(["snapshot", "--app", "Notes"], undefined, { quoteDelimitersConsumed: 0 }),
		);
		expect(snapshotIntent.forceApproval).toBeUndefined();

		const classifier = new IntentClassifier({ safe_mode: false });
		const approved = classifier.classify("cli", { command: "_desktop click @sa:e1" }, { intent: sendIntent });
		expect(approved.requires_approval).toBe(true);
		expect(approved.force_approval).toBe(true);
		expect(needsRuntimeApproval(approved.requires_approval, approved, new Set(["shell_dangerous"]))).toBe(true);

		const observed = classifier.classify("cli", { command: "_desktop snapshot --app Notes" }, { intent: snapshotIntent });
		expect(observed.requires_approval).toBe(false);
	});

	it("keeps typed text out of logged params, audit events, and the returned JSON", async () => {
		enable(workspaceA);
		await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const typed = await run(workspaceA, "thread-a", ["type", "@sa:e1", "hunter2"], events);
		expect(JSON.stringify(typed.params)).not.toContain("hunter2");
		expect(JSON.stringify(typed.result.details)).not.toContain("hunter2");
		expect(typed.result.content[0]?.text).not.toContain("hunter2");
		expect(calls.some((call) => call.args[0] === "type" && call.input === "hunter2" && call.args.includes("--stdin"))).toBe(true);
		expect(calls.some((call) => call.args.includes("hunter2"))).toBe(false);
		expect(JSON.stringify(events)).not.toContain("hunter2");

		await createAgentDesktopExtension({
			registerTool: () => undefined,
			registerCommand: () => undefined,
			registerCliCommand: () => undefined,
			on: () => undefined,
		} as never);
		const redacted = redactCommandForLog("_desktop type @sa:e1 hunter2");
		expect(redacted).not.toContain("hunter2");
		expect(redacted).toContain("--secret-ref");
		expect(redactDesktopCommandLine(redacted)).toBe(redacted);
	});

	it("refuses actions until accessibility is granted", async () => {
		enable(workspaceA);
		setDesktopRunnerForTests(async (args, options) => {
			calls.push({ args: [...args], cwd: options.cwd, input: options.input });
			if (args[0] === "permissions") {
				return envelope("permissions", { accessibility: { state: "denied" }, screen_recording: { state: "denied" } });
			}
			return envelope(args[0] ?? "unknown", {});
		});
		const blocked = await run(workspaceA, "thread-a", ["click", "@sa:e1"]);
		expect(blocked.result.content[0]?.text).toContain("PERM_DENIED");
		expect(calls.some((call) => call.args[0] === "click" || call.args[0] === "session")).toBe(false);
		expect(calls.some((call) => call.args[0] === "permissions")).toBe(true);
	});

	it("refuses to drive a browser page and points at _browser", async () => {
		enable(workspaceA);
		const blocked = await run(workspaceA, "thread-a", ["snapshot", "--app", "Safari"]);
		expect(blocked.result.content[0]?.text).toContain("WEB_PAGE");
		expect(blocked.result.content[0]?.text).toContain("_browser");
		expect(calls.some((call) => call.args[0] === "snapshot")).toBe(false);
	});
});
