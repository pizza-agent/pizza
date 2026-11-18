import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentBrowserExtension } from "../src/builtin-extensions/agent-browser/index.js";
import {
	checkAgentDesktopInstalled,
	createAgentDesktopExtension,
	getAgentDesktopPermissionStatus,
	openAgentDesktopPermissionSettings,
} from "../src/builtin-extensions/agent-desktop/index.js";
import {
	AGENT_DESKTOP_EXTENSION_ID,
	desktopBuiltinCommand,
	resetDesktopPermissionCache,
	setActiveDesktopCwd,
} from "../src/builtin-extensions/agent-desktop/cli-command.js";
import { platformCaveat, redactDesktopCommandLine } from "../src/builtin-extensions/agent-desktop/policy.js";
import { resetDesktopSecretsForTests } from "../src/builtin-extensions/agent-desktop/secrets.js";
import { resetDesktopSessionsForTests } from "../src/builtin-extensions/agent-desktop/session.js";
import { setDesktopRunnerForTests } from "../src/builtin-extensions/agent-desktop/runner.js";
import { createComputerUseExtension } from "../src/builtin-extensions/computer-use/index.js";
import { CONTEXT_ROUTER_EXTENSION_ID, createContextRouterExtension } from "../src/builtin-extensions/context-router/index.js";
import { BUILTIN_EXTENSIONS, getBuiltinExtensionFactories } from "../src/builtin-extensions/index.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { IntentClassifier, needsRuntimeApproval } from "../src/core/intent/classifier.js";
import { redactCommandForLog } from "../src/core/tools/command-redaction.js";
import { createAgentDesktopSimulator, type AgentDesktopSimulator } from "./agent-desktop-simulator.js";

const AUDIT_KEYS = new Set(["action", "outcome", "app", "snapshot_id", "ref", "artifact", "reason", "session_id"]);

describe("agent-desktop simulated CLI", () => {
	let root: string;
	let agentDir: string;
	let workspaceA: string;
	let workspaceB: string;
	let sim: AgentDesktopSimulator;
	let originalCwd: string;
	let originalPath: string | undefined;
	const originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalPath = process.env.PATH;
		root = mkdtempSync(join(tmpdir(), "pizza-desktop-"));
		agentDir = join(root, "agent");
		workspaceA = join(root, "ws-a");
		workspaceB = join(root, "ws-b");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspaceA, { recursive: true });
		mkdirSync(workspaceB, { recursive: true });
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
		resetDesktopSecretsForTests();
		resetDesktopSessionsForTests();
		resetDesktopPermissionCache();
		setActiveDesktopCwd(undefined);
		sim = createAgentDesktopSimulator();
		setDesktopRunnerForTests(sim.runner);
	});

	afterEach(() => {
		setDesktopRunnerForTests(undefined);
		setActiveDesktopCwd(undefined);
		process.chdir(originalCwd);
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
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
		const result = await desktopBuiltinCommand.execute("call-1", params, undefined, undefined, ctx(cwd, threadId, events));
		const text = result.content[0]?.text ?? "";
		const body = text.trim().startsWith("{") ? JSON.parse(text) as Record<string, any> : {};
		return { params, result, body };
	}

	function installStubBinary() {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		const file = join(bin, "agent-desktop");
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o755);
		process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
	}

	it("stays off until enabled, then can be disabled again, without a second tool", async () => {
		const manager = SettingsManager.create(workspaceA, agentDir);
		const disabled = manager.getDisabledBuiltinExtensions();
		expect(disabled.has(AGENT_DESKTOP_EXTENSION_ID)).toBe(true);
		expect(disabled.has(CONTEXT_ROUTER_EXTENSION_ID)).toBe(false);
		const initial = getBuiltinExtensionFactories(disabled);
		expect(initial.some((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)).toBe(false);
		expect(initial.some((ext) => ext.id === CONTEXT_ROUTER_EXTENSION_ID)).toBe(true);
		expect(initial.some((ext) => ext.id === "computer-use")).toBe(true);
		expect(initial.some((ext) => ext.id === "agent-browser")).toBe(true);
		expect(BUILTIN_EXTENSIONS.find((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)?.enabledByDefault).toBe(false);

		process.chdir(workspaceA);
		expect(desktopBuiltinCommand.isAvailable?.()).toBe(false);
		const blocked = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		expect(blocked.body.error.code).toBe("NOT_ENABLED");
		expect(sim.calls).toEqual([]);

		manager.setBuiltinExtensionDisabled(AGENT_DESKTOP_EXTENSION_ID, false);
		setActiveDesktopCwd(workspaceA);
		expect(desktopBuiltinCommand.isAvailable?.()).toBe(true);
		expect(getBuiltinExtensionFactories(manager.getDisabledBuiltinExtensions()).some((ext) => ext.id === AGENT_DESKTOP_EXTENSION_ID)).toBe(true);

		manager.setBuiltinExtensionDisabled(AGENT_DESKTOP_EXTENSION_ID, true);
		expect(desktopBuiltinCommand.isAvailable?.()).toBe(false);
		const disabledAgain = await run(workspaceA, "thread-a", ["click", "@s1:e1"]);
		expect(disabledAgain.body.error.code).toBe("NOT_ENABLED");
		expect(sim.calls).toEqual([]);

		const tools: string[] = [];
		const builtins: string[] = [];
		const register = {
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: () => undefined,
			registerCliCommand: (command: { name: string }) => builtins.push(command.name),
			on: () => undefined,
		};
		await createAgentDesktopExtension(register as never);
		await createComputerUseExtension(register as never);
		await createAgentBrowserExtension(register as never);
		await createContextRouterExtension(register as never);
		expect(tools).toEqual([]);
		expect(builtins).toEqual(expect.arrayContaining(["_desktop", "_computer_use", "_browser", "_context"]));
	});

	it("reports a missing CLI separately from a permission denial, and ready when both are present", async () => {
		enable(workspaceA);
		const missing = await checkAgentDesktopInstalled(workspaceA);
		if (!missing.installed) {
			const missingPermissions = await getAgentDesktopPermissionStatus(workspaceA);
			expect(missingPermissions.installed).toBe(false);
			expect(missingPermissions.ready).toBe(false);
			expect(missingPermissions.message).toContain("Install agent-desktop");
			if (platformCaveat()) expect(missingPermissions.message).toContain(platformCaveat());
		}

		sim = createAgentDesktopSimulator({ installed: false });
		setDesktopRunnerForTests(sim.runner);
		resetDesktopPermissionCache();
		const unavailable = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		expect(unavailable.body.error.code).toBe("CLI");
		expect(sim.calls.some((call) => call.args[0] === "snapshot")).toBe(false);

		installStubBinary();
		sim = createAgentDesktopSimulator({ accessibility: "denied", screenRecording: "denied" });
		setDesktopRunnerForTests(sim.runner);
		resetDesktopPermissionCache();
		const denied = await getAgentDesktopPermissionStatus(workspaceA);
		expect(denied.installed).toBe(true);
		expect(denied.ready).toBe(false);
		expect(denied.permissions.find((item) => item.kind === "accessibility")?.granted).toBe(false);
		const deniedAction = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		expect(deniedAction.body.error.code).toBe("PERM_DENIED");

		sim = createAgentDesktopSimulator({ accessibility: "granted", screenRecording: "denied" });
		setDesktopRunnerForTests(sim.runner);
		resetDesktopPermissionCache();
		const ready = await getAgentDesktopPermissionStatus(workspaceA);
		expect(ready.ready).toBe(true);
		expect(ready.permissions.find((item) => item.kind === "screenRecording")?.granted).toBe(false);
		const shot = await run(workspaceA, "thread-a", ["screenshot", "--app", "Notes"]);
		expect(shot.body.error.code).toBe("PERM_DENIED");
		expect(sim.calls.some((call) => call.args[0] === "screenshot")).toBe(false);

		if (process.platform !== "darwin") {
			const opened = await openAgentDesktopPermissionSettings(workspaceA, "accessibility");
			expect(opened.ok).toBe(false);
			expect(opened.message).toContain("not the primary path");
			expect(sim.calls.some((call) => call.args.includes("--guide"))).toBe(false);
		}
	});

	it("reuses one session per workspace and strips a model-supplied --session", async () => {
		enable(workspaceA);
		enable(workspaceB);
		const first = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes", "--session", "evil"]);
		expect(first.body.ok).toBe(true);
		expect(first.body.snapshot_id).toMatch(/^s\d+$/);
		expect(sim.calls.some((call) => call.args.includes("evil"))).toBe(false);
		const starts = () => sim.calls.filter((call) => call.args[0] === "session" && call.args[1] === "start");
		expect(starts()).toHaveLength(1);
		const sessionA = sim.sessionIds()[0]!;
		expect(sim.calls.some((call) => call.args[0] === "snapshot" && call.args.includes(sessionA))).toBe(true);

		await run(workspaceA, "thread-a", ["list-apps"]);
		expect(starts()).toHaveLength(1);

		await run(workspaceB, "thread-a", ["snapshot", "--app", "Notes"]);
		expect(starts()).toHaveLength(2);
		expect(sim.sessionIds()).toHaveLength(2);
		expect(new Set(sim.sessionIds()).size).toBe(2);
	});

	it("binds refs to the workspace and thread, and drops them after a mutation, invalidate, or vendor stale ref", async () => {
		enable(workspaceA);
		enable(workspaceB);
		const snap = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const ref = snap.body.elements.find((element: { name?: string }) => element.name === "Save").ref_id as string;
		const click = await run(workspaceA, "thread-a", ["click", ref]);
		expect(click.body.ok).toBe(true);
		expect(click.body.note).toContain("stale");
		const clicks = () => sim.calls.filter((call) => call.args[0] === "click").length;
		const afterFirst = clicks();

		const spent = await run(workspaceA, "thread-a", ["click", ref]);
		expect(spent.body.error.code).toBe("STALE_REF");
		expect(clicks()).toBe(afterFirst);

		const otherThread = await run(workspaceA, "thread-b", ["click", ref]);
		expect(otherThread.body.error.code).toBe("STALE_REF");
		expect(clicks()).toBe(afterFirst);

		const otherWorkspace = await run(workspaceB, "thread-a", ["click", ref]);
		expect(otherWorkspace.body.error.code).toBe("STALE_REF");
		expect(sim.calls.some((call) => call.cwd === workspaceB && call.args[0] === "click")).toBe(false);

		const again = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const fresh = again.body.elements.find((element: { name?: string }) => element.name === "Save").ref_id as string;
		await run(workspaceA, "thread-a", ["invalidate"]);
		const afterInvalidate = await run(workspaceA, "thread-a", ["click", fresh]);
		expect(afterInvalidate.body.error.code).toBe("STALE_REF");
		expect(clicks()).toBe(afterFirst);

		const resnap = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const live = resnap.body.elements.find((element: { name?: string }) => element.name === "Save").ref_id as string;
		sim.dropElement("Notes", "Save");
		const vendorStale = await run(workspaceA, "thread-a", ["click", live]);
		expect(vendorStale.body.error.code).toBe("STALE_REF");
		const afterVendor = clicks();
		const follow = await run(workspaceA, "thread-a", ["click", live]);
		expect(follow.body.error.code).toBe("STALE_REF");
		expect(clicks()).toBe(afterVendor);
	});

	it("starts a new session after the vendor says the old one ended, and does not keep the old id", async () => {
		enable(workspaceA);
		const snap = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"]);
		const ref = snap.body.elements[0].ref_id as string;
		const first = sim.sessionIds()[0]!;
		sim.expireSessions();
		const acted = await run(workspaceA, "thread-a", ["click", ref]);
		expect(sim.sessionIds().length).toBe(2);
		expect(acted.body.ok).toBe(false);
		const clickCalls = sim.calls.filter((call) => call.args[0] === "click");
		expect(clickCalls.at(-1)?.args).toContain(sim.sessionIds()[1]);
		expect(clickCalls.at(-1)?.args).not.toContain(first);
	});

	it("confirms send, pay, delete, quit, and account actions, and refuses batch and held keys", async () => {
		enable(workspaceA);
		const snap = await run(workspaceA, "thread-a", ["snapshot", "--app", "Mail"]);
		const classifier = new IntentClassifier({ safe_mode: false });
		for (const name of ["Send", "Pay", "Delete", "Account settings"]) {
			const ref = snap.body.elements.find((element: { name?: string }) => element.name === name).ref_id as string;
			const params = desktopBuiltinCommand.parseArguments!(["click", ref], undefined, { quoteDelimitersConsumed: 0 });
			const intent = desktopBuiltinCommand.classify!(params);
			expect(intent.forceApproval).toBe(true);
			const decision = classifier.classify("cli", { command: `_desktop click ${ref}` }, { intent });
			expect(decision.requires_approval).toBe(true);
			expect(needsRuntimeApproval(decision.requires_approval, decision, new Set(["shell_dangerous"]))).toBe(true);
		}
		const quit = desktopBuiltinCommand.classify!(
			desktopBuiltinCommand.parseArguments!(["press", "cmd+q"], undefined, { quoteDelimitersConsumed: 0 }),
		);
		expect(quit.forceApproval).toBe(true);
		const closeApp = desktopBuiltinCommand.classify!(
			desktopBuiltinCommand.parseArguments!(["close-app", "--app", "Mail"], undefined, { quoteDelimitersConsumed: 0 }),
		);
		expect(closeApp.forceApproval).toBe(true);
		const observe = desktopBuiltinCommand.classify!(
			desktopBuiltinCommand.parseArguments!(["snapshot", "--app", "Notes"], undefined, { quoteDelimitersConsumed: 0 }),
		);
		expect(classifier.classify("cli", { command: "_desktop snapshot" }, { intent: observe }).requires_approval).toBe(false);

		for (const sub of ["batch", "key-down", "key-up", "mouse-down", "mouse-up"]) {
			const refused = await run(workspaceA, "thread-a", [sub, "@s1:e1"]);
			expect(refused.body.error.code).toBe("INVALID_ARGS");
		}
		expect(sim.calls.some((call) => ["batch", "key-down", "key-up", "mouse-down", "mouse-up"].includes(call.args[0] ?? ""))).toBe(false);
	});

	it("keeps web pages on _browser and still allows a browser's menu bar", async () => {
		enable(workspaceA);
		expect(desktopBuiltinCommand.promptGuidelines?.join("\n")).toContain("_browser");
		const page = await run(workspaceA, "thread-a", ["snapshot", "--app", "Safari"]);
		expect(page.body.error.code).toBe("WEB_PAGE");
		expect(page.body.error.message).toContain("_browser");
		expect(sim.calls.some((call) => call.args[0] === "snapshot" && call.args.includes("Safari"))).toBe(false);

		const menu = await run(workspaceA, "thread-a", ["snapshot", "--app", "Safari", "--surface", "menubar"]);
		expect(menu.body.ok).toBe(true);
		const item = menu.body.elements.find((element: { name?: string }) => element.name === "New Window");
		expect(item.ref_id).toMatch(/^@s\d+:e\d+$/);
		const clicked = await run(workspaceA, "thread-a", ["click", item.ref_id]);
		expect(clicked.body.ok).toBe(true);
		expect(sim.calls.some((call) => call.args[0] === "click" && call.args.includes(item.ref_id))).toBe(true);
	});

	it("redacts secrets from params, events, tool JSON, and snapshot artifacts", async () => {
		enable(workspaceA);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const snap = await run(workspaceA, "thread-a", ["snapshot", "--app", "Notes"], events);
		expect(JSON.stringify(snap.body)).not.toContain("s3cret-token");
		expect(snap.body.artifact).toBeTruthy();
		expect(readFileSync(snap.body.artifact, "utf8")).not.toContain("s3cret-token");
		const field = snap.body.elements.find((element: { role?: string }) => element.role === "textfield");
		const typed = await run(workspaceA, "thread-a", ["type", field.ref_id, "hunter2"], events);
		expect(JSON.stringify(typed.params)).not.toContain("hunter2");
		expect(JSON.stringify(typed.result.details)).not.toContain("hunter2");
		expect(typed.result.content[0]?.text).not.toContain("hunter2");
		expect(JSON.stringify(events)).not.toContain("hunter2");
		expect(sim.calls.some((call) => call.args[0] === "type" && call.input === "hunter2" && call.args.includes("--stdin"))).toBe(true);
		expect(sim.calls.some((call) => call.args.includes("hunter2"))).toBe(false);
		const audit = events.find((event) => event.type === "DESKTOP_ACTION");
		for (const key of Object.keys(audit!.payload)) expect(AUDIT_KEYS.has(key)).toBe(true);
		expect(audit!.payload).not.toHaveProperty("version");

		await createAgentDesktopExtension({
			registerTool: () => undefined,
			registerCommand: () => undefined,
			registerCliCommand: () => undefined,
			on: () => undefined,
		} as never);
		const redacted = redactCommandForLog("_desktop type @s1:e1 hunter2");
		expect(redacted).not.toContain("hunter2");
		expect(redactDesktopCommandLine(redacted)).toBe(redacted);
	});

	it("states that Windows and Linux are not the primary path", async () => {
		expect(platformCaveat("darwin")).toBeUndefined();
		expect(platformCaveat("win32")).toContain("not the primary path");
		expect(platformCaveat("win32")).toContain("UI Automation");
		expect(platformCaveat("linux")).toContain("not the primary path");
		expect(platformCaveat("linux")).toContain("AT-SPI");

		enable(workspaceA);
		const help = await run(workspaceA, "thread-a", ["help"]);
		const status = await run(workspaceA, "thread-a", ["status"]);
		const caveat = platformCaveat();
		if (caveat) {
			expect(help.result.content[0]?.text).toContain("not the primary path");
			expect(status.body.platform_note).toContain("not the primary path");
		}
		expect(help.result.content[0]?.text).toContain("_browser");
		expect(status.body.ok).toBe(true);
	});
});
