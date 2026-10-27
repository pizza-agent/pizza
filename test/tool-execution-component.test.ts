import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { beforeAll, afterEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";
import { formatLineAnchor } from "../src/core/tools/line-anchors.js";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { ToolExecutionComponent } from "../packages/tui/components/tool-execution.js";
import { initTheme } from "../packages/tui/theme/theme.js";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", edits: [{ op: "replace", range: formatLineAnchor(1, "before"), new: "after" }] },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("cli call renders its timeout in milliseconds", () => {
		const component = new ToolExecutionComponent(
			"cli", "tool-timeout-ms", { command: "echo ok", timeout: 1500 }, {},
			createBashToolDefinition(process.cwd()), createFakeTui(), process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("(timeout 1500ms)");
	});

	test("cli execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-cli-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("cli built-in read executes through the read tool and returns structured details", async () => {
		const testDir = await mkdtemp(join(tmpdir(), "pizza-cli-builtin-read-"));
		try {
			await writeFile(join(testDir, "sample.txt"), "hello\nworld\n", "utf-8");
			const tool = createBashToolDefinition(testDir);
			const result = await tool.execute("tool-cli-read", { command: "_read sample.txt --offset 2 --limit 1" });

			expect(result.content[0]?.type).toBe("text");
			expect(result.content[0]?.text).toContain("world");
			expect(result.details?.builtin).toMatchObject({
				name: "read",
				args: { path: "sample.txt", offset: 2, limit: 1 },
			});
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	test("rebases fallback call rendering when streaming later provides the cli tool name", () => {
		const component = new ToolExecutionComponent(
			"",
			"tool-streaming-name",
			{ command: "ls -la /Users/gongchao/coding/" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		const fallbackRendered = stripAnsi(component.render(120).join("\n"));
		expect(fallbackRendered).toContain("\"command\"");

		component.updateToolCall(
			"cli",
			{ command: "ls -la /Users/gongchao/coding/" },
			undefined,
		);

		const cliRendered = stripAnsi(component.render(120).join("\n"));
		expect(cliRendered).toContain("ls");
		expect(cliRendered).toContain("$ ls -la /Users/gongchao/coding/");
		expect(cliRendered).not.toContain("\"command\"");
	});

	test("cli built-in read call uses the read renderer", () => {
		const component = new ToolExecutionComponent(
			"cli",
			"tool-cli-read-render",
			{ command: "_read README.md --offset 2 --limit 3" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md:2-4");
		expect(rendered).not.toContain("$ _read README.md");
	});

	test("cli built-in edit result uses the edit diff renderer", () => {
		const component = new ToolExecutionComponent(
			"cli",
			"tool-cli-edit-render",
			{ command: `edit --path README.md --op replace --range ${formatLineAnchor(1, "before")} --new after` },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully applied 1 edit(s) in README.md." }],
				details: {
					builtin: {
						name: "edit",
						args: { path: "README.md", edits: [{ op: "replace", range: formatLineAnchor(1, "before"), new: "after" }] },
						details: { diff: "@@ -1 +1 @@\n-before\n+after", firstChangedLine: 1 },
					},
				},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("+after");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});
});

describe("ToolExecutionComponent generic running indicator", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows a Running... loader between execution start and first feedback", () => {
		vi.useFakeTimers();
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-run-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		// Before execution starts: no running indicator.
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Running...");

		component.markExecutionStarted();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Running...");

		// Final result removes the indicator and shows the result instead.
		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).not.toContain("Running...");
		expect(rendered).toContain("custom result");
	});

	test("partial streamed feedback replaces the generic loader (no double indicator for cli)", () => {
		vi.useFakeTimers();
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-run-2",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Running...");

		// First streamed partial update (like cli's initial empty update) hides the loader.
		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				isError: false,
			},
			true,
		);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Running...");
	});

	test("stops the loader animation timer once the result arrives", () => {
		vi.useFakeTimers();
		let renderCalls = 0;
		const fakeTui = {
			requestRender: () => {
				renderCalls++;
			},
		} as unknown as TUI;

		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-run-3",
			{},
			{},
			toolDefinition,
			fakeTui,
			process.cwd(),
		);
		component.markExecutionStarted();

		// Loader animates: requestRender fires on its interval while running.
		const before = renderCalls;
		vi.advanceTimersByTime(400);
		expect(renderCalls).toBeGreaterThan(before);

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		// Animation stopped: no further requestRender calls from the loader.
		const afterResult = renderCalls;
		vi.advanceTimersByTime(400);
		expect(renderCalls).toBe(afterResult);
	});

	test("fallback rendering (no tool definition) also shows a running marker", () => {
		vi.useFakeTimers();
		const component = new ToolExecutionComponent(
			"mystery_tool",
			"tool-run-4",
			{ path: "x" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Running...");

		component.markExecutionStarted();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Running...");
	});
});
