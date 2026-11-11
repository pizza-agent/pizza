import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import { AgentToolAdapter, createToolRegistry } from "../src/core/intent/tool-adapter.js";
import { LocalRuntimeAdapter } from "../src/core/runtime/local-runtime.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { createCliToolDefinition } from "../src/core/tools/cli.js";
import { CommandRegistry } from "../src/core/tools/command-registry.js";
import { createBuiltinCliCommands } from "../src/core/tools/builtin-cli-commands.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.js";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";
import type { AgentTool } from "../src/core/agent/types.js";
import type { CliCommandDefinition } from "../src/core/extensions/types.js";
import type { ToolCallGate } from "../src/core/runtime/reactor.js";

const dirs: string[] = [];
const runtimes: EventSourcedRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), "pizza-tools-contract-")); dirs.push(dir); return dir; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const ok = () => ({ content: [{ type: "text" as const, text: "ok" }] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function tool(overrides: Partial<AgentTool<any>> = {}): AgentTool<any> {
	return { name: "fixture", description: "fixture", parameters: Type.Object({}), execute: async () => ok(), ...overrides };
}
async function runtimeFor(tools: AgentTool<any>[], calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, gate?: ToolCallGate, strict = false) {
	const dir = await tempDir(); let rounds = 0;
	const runtime = new EventSourcedRuntime({ cwd: dir, agentDir: dir, toolRegistry: createToolRegistry(tools),
		classifierConfig: { safe_mode: !strict ? false : true }, beforeToolCall: gate,
		systemPrompt: "test", model: { provider: "test", model_id: "test" }, tools: [],
		llmClient: { async complete() { const first = rounds++ === 0; return {
			content: first ? calls.map(call => ({ type: "tool_call" as const, ...call })) : [{ type: "text" as const, text: "done" }],
			provider: "test", model: "test", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stopReason: first ? "tool_use" as const : "stop" as const,
		}; } },
	});
	runtimes.push(runtime); return runtime;
}

describe("file mutation cancellation and identity", () => {
	it.each(["write", "edit"])("holds the queue until an in-flight %s settles after cancellation", async kind => {
		const dir = await tempDir(), started = deferred(), finish = deferred(); const controller = new AbortController();
		let contents = "original", secondStarted = false;
		const operations = { access: async () => {}, readFile: async () => Buffer.from(contents), mkdir: async () => {},
			writeFile: async (_path: string, content: string) => { started.resolve(); await finish.promise; contents = content; } };
		const firstTool = kind === "write" ? createWriteToolDefinition(dir, { operations }) : createEditToolDefinition(dir, { operations });
		const input = kind === "write" ? { path: "a.txt", content: "FIRST" } : { path: "a.txt", edits: [{ op: "search", old: "original", new: "FIRST" }] };
		const first = firstTool.execute("first", input as any, controller.signal);
		await started.promise; controller.abort();
		const second = createWriteToolDefinition(dir, { operations: { mkdir: async () => {}, writeFile: async (_path, value) => { secondStarted = true; contents = value; } } }).execute("second", { path: "a.txt", content: "SECOND" });
		await tick(); expect(secondStarted).toBe(false);
		finish.resolve(); expect((await first).content[0]).toMatchObject({ text: expect.stringContaining("completed") });
		await second; expect(contents).toBe("SECOND");
	});
	it("does not write when cancellation happens during the read phase", async () => {
		const dir = await tempDir(), started = deferred(), finish = deferred(), controller = new AbortController(); const write = vi.fn();
		const edit = createEditToolDefinition(dir, { operations: { access: async () => {}, readFile: async () => { started.resolve(); await finish.promise; return Buffer.from("old"); }, writeFile: write } });
		const result = edit.execute("edit", { path: "a", edits: [{ op: "search", old: "old", new: "new" }] }, controller.signal);
		const rejected = expect(result).rejects.toThrow("aborted before writing");
		await started.promise; controller.abort(); finish.resolve(); await rejected; expect(write).not.toHaveBeenCalled();
	});
	it("keeps permission errors distinct from missing files", async () => {
		const dir = await tempDir(); const denied = new Error("EACCES: permission denied");
		const edit = createEditToolDefinition(dir, { operations: { access: async () => { throw denied; }, readFile: vi.fn(), writeFile: vi.fn() } });
		await expect(edit.execute("edit", { path: "a", edits: [{ op: "search", old: "old", new: "new" }] })).rejects.toBe(denied);
	});
	it("serializes a not-yet-created file through a symlinked ancestor", async () => {
		const dir = await tempDir(); await mkdir(join(dir, "real")); await symlink(join(dir, "real"), join(dir, "alias"), "junction");
		const started = deferred(), finish = deferred(); const order: string[] = [];
		const first = withFileMutationQueue(join(dir, "real/missing/new.txt"), async () => { order.push("first:start"); started.resolve(); await finish.promise; order.push("first:end"); });
		await started.promise;
		const second = withFileMutationQueue(join(dir, "alias/missing/new.txt"), async () => { order.push("second"); });
		await tick(); expect(order).toEqual(["first:start"]); finish.resolve(); await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});
	it("reports UTF-8 bytes rather than character count", async () => {
		const dir = await tempDir(); const write = createWriteToolDefinition(dir);
		const result = await write.execute("write", { path: "unicode.txt", content: "中文" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("6 bytes") });
	});
});

describe("approval command semantics", () => {
	it.each(["find . -delete", "find . -exec touch x +", "find . -fprint out.txt", "git branch -D topic", "git branch new-topic", "git remote remove origin", "git remote set-url origin https://example.test", "npm config set registry https://example.test", "git diff --output=out.patch", "date 010100002026"])("strict mode gates %s", command => {
		expect(new IntentClassifier({ safe_mode: true }).classify("cli", { command }).requires_approval).toBe(true);
		expect(new IntentClassifier({ safe_mode: false }).classify("cli", { command }).requires_approval).toBe(false);
	});
	it.each(["find . -name '*.ts'", "git branch -av", "git remote -v", "git remote get-url origin", "npm config get registry", "git diff --stat", "date -u"])("keeps read-only forms ungated: %s", command => {
		expect(new IntentClassifier({ safe_mode: true }).classify("cli", { command }).risk).toBe("safe");
	});
});

describe("tool preparation and progress", () => {
	it("rejects invalid schema arguments before executing", async () => {
		const execute = vi.fn(async () => ok()); const adapter = new AgentToolAdapter(tool({ parameters: Type.Object({ count: Type.Integer() }), execute }));
		expect((await adapter.execute({ count: "wrong" })).is_error).toBe(true); expect(execute).not.toHaveBeenCalled();
	});
	it("prepares once and shares normalized arguments with resolve and execute", async () => {
		const prepare = vi.fn(args => ({ count: Number(args.count) })); const resolve = vi.fn(() => undefined), execute = vi.fn(async () => ok());
		const adapter = new AgentToolAdapter(tool({ parameters: Type.Object({ count: Type.Integer() }), prepareArguments: prepare, resolve, execute }));
		const raw = { count: "2" }; const normalized = adapter.prepareArguments(raw, "id"); adapter.resolve(normalized, "id"); await adapter.execute(normalized, { tool_call_id: "id" });
		expect(prepare).toHaveBeenCalledTimes(1); expect(resolve).toHaveBeenCalledWith({ count: 2 }, "id"); expect(execute.mock.calls[0][1]).toEqual({ count: 2 }); expect(raw.count).toBe("2");
	});
	it("turns prepareArguments exceptions into error results", async () => {
		const adapter = new AgentToolAdapter(tool({ prepareArguments: () => { throw new Error("invalid input"); } }));
		expect(await adapter.execute({})).toMatchObject({ is_error: true, error_message: "invalid input" });
	});
	it("passes command updates with the same metadata envelope as final results", async () => {
		const command: CliCommandDefinition = { name: "_progress", description: "test", parameters: Type.Object({}), execute: async (_id, _params, _signal, onUpdate) => { onUpdate?.({ ...ok(), details: { progress: 0.5 } }); return { ...ok(), details: { progress: 1 } }; } };
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [command] }) }); const updates: any[] = [];
		const result = await cli.execute("id", { command: "_progress --json '{}'" }, undefined, update => updates.push(update), {} as any);
		expect(updates).toHaveLength(1); expect(updates[0].details.command).toMatchObject({ name: "_progress", source: "sdk", args: {}, details: { progress: 0.5 } });
		expect(result.details?.command?.details).toEqual({ progress: 1 });
	});
	it("validates a command's custom parser against its declared schema", async () => {
		const execute = vi.fn(async () => ok()); const command: CliCommandDefinition = { name: "_invalid", description: "test", parameters: Type.Object({ count: Type.Integer() }), parseArguments: () => ({ count: "wrong" }), execute };
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [command] }) });
		await expect(cli.execute("id", { command: "_invalid go" })).rejects.toThrow("Invalid tool arguments"); expect(execute).not.toHaveBeenCalled();
	});
	it("does not execute pre-cancelled tools", async () => {
		const execute = vi.fn(async () => ok()), controller = new AbortController(); controller.abort();
		expect((await new AgentToolAdapter(tool({ execute })).execute({}, { signal: controller.signal })).is_error).toBe(true); expect(execute).not.toHaveBeenCalled();
	});
});

describe("runtime ordering and approved arguments", () => {
	it("runs sequential tools exclusively, preserving the surrounding parallel barriers", async () => {
		const dir = await tempDir(), order: string[] = [], firstStarted = deferred(), finishFirst = deferred();
		const registry = createToolRegistry([
			tool({ name: "parallel", execute: async id => { order.push(id + ":start"); if (id === "first") { firstStarted.resolve(); await finishFirst.promise; } order.push(id + ":end"); return ok(); } }),
			tool({ name: "serial", executionMode: "sequential", execute: async () => { order.push("serial"); return ok(); } }),
		]);
		const adapter = new LocalRuntimeAdapter({ workspace_id: "test", cwd: dir, toolRegistry: registry });
		const first = adapter.executeTool({ tool_call_id: "first", tool_name: "parallel", arguments: {} }); await firstStarted.promise;
		const second = adapter.executeTool({ tool_call_id: "second", tool_name: "serial", arguments: {} });
		const third = adapter.executeTool({ tool_call_id: "third", tool_name: "parallel", arguments: {} });
		await tick(); expect(order).toEqual(["first:start"]); finishFirst.resolve(); await Promise.all([first, second, third]);
		expect(order).toEqual(["first:start", "first:end", "serial", "third:start", "third:end"]); expect((await adapter.getStatus()).status).toBe("idle");
	});
	it("honors sequential SDK commands through the unified cli", async () => {
		let active = 0, maxActive = 0;
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [{ name: "_serial", description: "test", parameters: Type.Object({}), executionMode: "sequential", execute: async () => { maxActive = Math.max(maxActive, ++active); await tick(); active--; return ok(); } }] }) });
		const runtime = await runtimeFor([wrapToolDefinition(cli)], [1, 2].map(id => ({ id: String(id), name: "cli", arguments: { command: "_serial --json '{}'" } })));
		await runtime.prompt("test"); expect(maxActive).toBe(1);
	});
	it("rejects invalid arguments before requesting approval", async () => {
		const execute = vi.fn(async () => ok()); const runtime = await runtimeFor([tool({ parameters: Type.Object({ count: Type.Integer() }), execute })], [{ id: "bad", name: "fixture", arguments: { count: "wrong" } }], undefined, true);
		await runtime.prompt("test"); expect(execute).not.toHaveBeenCalled();
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload).toMatchObject({ is_error: true });
		expect(JSON.stringify(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload)).toContain("Invalid tool arguments");
	});
	it.each(["arguments", "parsed command"])("rejects post-approval mutations of %s", async target => {
		const execute = vi.fn(async () => ok()); const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [{ name: "_test", description: "test", parameters: Type.Object({ value: Type.String() }), execute }] }) });
		const runtime = await runtimeFor([wrapToolDefinition(cli)], [{ id: "change", name: "cli", arguments: { command: "_test --value original" } }], async call => {
			if (target === "arguments") call.arguments.command = "_test --value changed";
			else (call.command!.params as any).value = "changed";
		});
		await runtime.prompt("test"); expect(execute).not.toHaveBeenCalled();
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload).toMatchObject({ is_error: true });
		expect(JSON.stringify(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload)).toContain("changed arguments after approval");
	});
});

describe("builtin business failures", () => {
	it.each(["_cron list", "_skill load --name missing", "_history_tree jump missing", "_session_split"])("records %s as an error", async command => {
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: createBuiltinCliCommands(process.cwd(), { cron: { getEngine: () => undefined }, skill: { getSkills: () => [{ name: "available" } as any] } }) }) });
		const result = await new AgentToolAdapter(wrapToolDefinition(cli)).execute({ command });
		expect(result.is_error).toBe(true); expect(result.error_message).toBeTruthy();
	});
});

describe("tool semantic edge cases", () => {
	it.each(["_read a.txt --limit -1", "_read a.txt --limit 0", "_read a.txt --offset -2", "_read a.txt --offset 1.5"])("rejects invalid read boundaries before I/O: %s", async command => {
		const readFile = vi.fn();
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: createBuiltinCliCommands(process.cwd(), { read: { operations: { readFile, access: vi.fn() } } }) }) });
		const result = await new AgentToolAdapter(wrapToolDefinition(cli)).execute({ command });
		expect(result.is_error).toBe(true); expect(readFile).not.toHaveBeenCalled();
	});
	it.each([-1, 1.5, 2147483648, Infinity])("rejects unsupported timeout values: %s", async timeout => {
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [] }) });
		expect((await new AgentToolAdapter(wrapToolDefinition(cli)).execute({ command: "anything", timeout })).is_error).toBe(true);
	});
	it("keeps an actual timed-out write locked until I/O completes", async () => {
		const dir = await tempDir(), started = deferred(), finish = deferred(); let content = "original", secondStarted = false;
		const commands = createBuiltinCliCommands(dir, { write: { operations: { mkdir: async () => {}, writeFile: async (_path, value) => { started.resolve(); await finish.promise; content = value; } } } });
		const cli = createCliToolDefinition(dir, { registry: new CommandRegistry({ builtins: commands }) });
		const result = cli.execute("timeout", { command: "_write a.txt FIRST", timeout: 10 });
		const timeout = expect(result).rejects.toThrow("operation may still complete"); await started.promise; await timeout;
		const second = createWriteToolDefinition(dir, { operations: { mkdir: async () => {}, writeFile: async (_path, value) => { secondStarted = true; content = value; } } }).execute("second", { path: "a.txt", content: "SECOND" });
		await tick(); expect(secondStarted).toBe(false); finish.resolve(); await second; expect(content).toBe("SECOND");
	});
	it("suppresses progress after a command times out", async () => {
		const finish = deferred(), ended = deferred(); const updates: unknown[] = [];
		const command: CliCommandDefinition = { name: "_slow", description: "test", parseArguments: () => ({}), execute: async (_id, _params, _signal, update) => {
			update?.(ok()); await finish.promise; update?.(ok()); ended.resolve(); return ok();
		} };
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [command] }) });
		await expect(cli.execute("id", { command: "_slow run", timeout: 10 }, undefined, update => updates.push(update), {} as any)).rejects.toThrow("timed out");
		finish.resolve(); await ended.promise; expect(updates).toHaveLength(1);
	});
	it("does not execute a cancelled tool after it finishes waiting for a sequential barrier", async () => {
		const dir = await tempDir(), started = deferred(), finish = deferred(), controller = new AbortController(); const execute = vi.fn(async () => ok());
		const registry = createToolRegistry([tool({ name: "hold", executionMode: "sequential", execute: async () => { started.resolve(); await finish.promise; return ok(); } }), tool({ execute })]);
		const adapter = new LocalRuntimeAdapter({ workspace_id: "test", cwd: dir, toolRegistry: registry });
		const first = adapter.executeTool({ tool_call_id: "hold", tool_name: "hold", arguments: {} }); await started.promise;
		const second = adapter.executeTool({ tool_call_id: "cancelled", tool_name: "fixture", arguments: {}, signal: controller.signal });
		controller.abort(); finish.resolve(); await first; expect((await second).is_error).toBe(true); expect(execute).not.toHaveBeenCalled();
	});
});

describe("resolved command identity", () => {
	it("rejects a rewritten command even when the cli is invoked without the reactor", async () => {
		const execute = vi.fn(async () => ok()); const command: CliCommandDefinition = { name: "_identity", description: "test", parameters: Type.Object({ value: Type.String() }), execute };
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [command] }) });
		cli.resolve!({ command: "_identity --value original" }, "id");
		await expect(cli.execute("id", { command: "_identity --value changed" })).rejects.toThrow("changed after approval"); expect(execute).not.toHaveBeenCalled();
	});
	it("rechecks availability when a previously resolved capability is disabled", async () => {
		let available = true; const execute = vi.fn(async () => ok());
		const command: CliCommandDefinition = { name: "_availability", description: "test", parseArguments: () => ({}), isAvailable: () => available, execute };
		const cli = createCliToolDefinition(process.cwd(), { registry: new CommandRegistry({ builtins: [], sdk: [command] }) });
		cli.resolve!({ command: "_availability run" }, "id"); available = false;
		await expect(cli.execute("id", { command: "_availability run" })).rejects.toThrow("no longer available"); expect(execute).not.toHaveBeenCalled();
	});
	it.skipIf(process.platform === "win32")("uses the same queue through a dangling file symlink", async () => {
		const dir = await tempDir(); await symlink("new.txt", join(dir, "alias.txt"));
		const started = deferred(), finish = deferred(); let secondStarted = false;
		const first = withFileMutationQueue(join(dir, "new.txt"), async () => { started.resolve(); await finish.promise; }); await started.promise;
		const second = withFileMutationQueue(join(dir, "alias.txt"), async () => { secondStarted = true; });
		await tick(); expect(secondStarted).toBe(false); finish.resolve(); await Promise.all([first, second]); expect(secondStarted).toBe(true);
	});
});

describe("prepared calls across registry rebuilds", () => {
	it("does not run normalization again when the executor was rebuilt after approval", async () => {
		const prepare = vi.fn(args => ({ count: args.count + 1 })), execute = vi.fn(async () => ok());
		const definition = tool({ parameters: Type.Object({ count: Type.Integer() }), prepareArguments: prepare, execute });
		const prepared = new AgentToolAdapter(definition).prepareArguments({ count: 1 }, "id");
		const rebuilt = new AgentToolAdapter(definition);
		expect((await rebuilt.execute(prepared, { tool_call_id: "id", arguments_prepared: true })).is_error).toBe(false);
		expect(prepare).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0][1]).toEqual({ count: 2 });
	});
});
