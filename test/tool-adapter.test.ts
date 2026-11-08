import { describe, it, expect } from "vitest";
import { AgentToolAdapter, createToolRegistry } from "../src/core/intent/tool-adapter.js";
import type { AgentTool } from "../src/core/agent/types.js";

function createMockTool(name: string, overrides?: Partial<AgentTool<any, any>>): AgentTool<any, any> {
	return {
		name,
		description: `Mock ${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text" as const, text: `executed ${name} with ${JSON.stringify(params)}` }],
		}),
		...overrides,
	} as AgentTool<any, any>;
}

describe("AgentToolAdapter", () => {
	it("wraps AgentTool execute into ToolExecutor interface", async () => {
		const tool = createMockTool("read");
		const adapter = new AgentToolAdapter(tool);

		const result = await adapter.execute({ path: "/tmp/test.ts" });

		expect(result.is_error).toBe(false);
		expect(result.content[0]).toHaveProperty("text");
		expect((result.content[0] as any).text).toContain("read");
	});

	it("detects file mutations for the _edit command", async () => {
		const tool = createMockTool("cli", {
			execute: async () => ({
				content: [{ type: "text" as const, text: "edited" }],
				details: { command: { source: "builtin", name: "_edit", args: { path: "src/app.ts" } } },
			}),
		});
		const adapter = new AgentToolAdapter(tool);

		const result = await adapter.execute({ command: "_edit src/app.ts replace 1#a x" });

		expect(result.is_error).toBe(false);
		expect(result.file_mutations).toBeDefined();
		expect(result.file_mutations).toHaveLength(1);
		expect(result.file_mutations![0]).toEqual({ path: "src/app.ts", operation: "modify" });
	});

	it("detects file mutations for the _write command", async () => {
		const tool = createMockTool("cli", {
			execute: async () => ({
				content: [{ type: "text" as const, text: "written" }],
				details: { command: { source: "builtin", name: "_write", args: { path: "new-file.ts" } } },
			}),
		});
		const adapter = new AgentToolAdapter(tool);

		const result = await adapter.execute({ command: "_write new-file.ts hello" });

		expect(result.file_mutations).toHaveLength(1);
		expect(result.file_mutations![0]).toEqual({ path: "new-file.ts", operation: "create" });
	});

	it("does not add file_mutations for custom tools", async () => {
		const tool = createMockTool("grep");
		const adapter = new AgentToolAdapter(tool);

		const result = await adapter.execute({ pattern: "foo", path: "." });

		expect(result.file_mutations).toBeUndefined();
	});

	it("catches errors and returns is_error result", async () => {
		const tool = createMockTool("edit", {
			execute: async () => {
				throw new Error("File not found: /bad/path.ts");
			},
		});
		const adapter = new AgentToolAdapter(tool);

		const result = await adapter.execute({ path: "/bad/path.ts" });

		expect(result.is_error).toBe(true);
		expect(result.error_message).toBe("File not found: /bad/path.ts");
		expect((result.content[0] as any).text).toContain("File not found");
	});

	it("applies prepareArguments hook", async () => {
		let receivedArgs: any;
		const tool = createMockTool("edit", {
			prepareArguments: (args: any) => ({ ...args, normalized: true }),
			execute: async (_id, params) => {
				receivedArgs = params;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		});
		const adapter = new AgentToolAdapter(tool);

		await adapter.execute({ path: "test.ts" });

		expect(receivedArgs.normalized).toBe(true);
		expect(receivedArgs.path).toBe("test.ts");
	});

	it("passes runtime execution context to AgentTool", async () => {
		let receivedToolCallId: string | undefined;
		let receivedSignal: AbortSignal | undefined;
		let updateText: string | undefined;
		const signal = new AbortController().signal;
		const tool = createMockTool("read", {
			execute: async (toolCallId, _params, toolSignal, onUpdate) => {
				receivedToolCallId = toolCallId;
				receivedSignal = toolSignal;
				onUpdate?.({ content: [{ type: "text" as const, text: "partial" }] });
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		});
		const adapter = new AgentToolAdapter(tool);

		await adapter.execute({ path: "test.ts" }, {
			tool_call_id: "call_123",
			signal,
			onUpdate: (partial) => {
				const textBlock = partial.content[0] as { text?: string };
				updateText = textBlock.text;
			},
		});

		expect(receivedToolCallId).toBe("call_123");
		expect(receivedSignal).toBe(signal);
		expect(updateText).toBe("partial");
	});

	it("returns correct metadata", () => {
		const readTool = new AgentToolAdapter(createMockTool("read"));
		expect(readTool.getMetadata()).toEqual({
			name: "read",
			description: "Mock read tool",
			category: "unknown",
			defaultRisk: "dangerous",
		});

		const editTool = new AgentToolAdapter(createMockTool("edit"));
		expect(editTool.getMetadata()).toEqual({
			name: "edit",
			description: "Mock edit tool",
			category: "unknown",
			defaultRisk: "dangerous",
		});

		const cliTool = new AgentToolAdapter(createMockTool("cli"));
		expect(cliTool.getMetadata()).toEqual({
			name: "cli",
			description: "Mock cli tool",
			category: "shell_moderate",
			defaultRisk: "moderate",
		});
	});
});

describe("createToolRegistry", () => {
	it("creates a registry from AgentTool array", () => {
		const tools = [createMockTool("read"), createMockTool("edit"), createMockTool("cli")];
		const registry = createToolRegistry(tools);

		expect(registry.list()).toEqual(["read", "edit", "cli"]);
		expect(registry.get("read")).toBeDefined();
		expect(registry.get("edit")).toBeDefined();
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	it("registry executors work correctly", async () => {
		const tools = [createMockTool("cli", {
			execute: async () => ({
				content: [{ type: "text" as const, text: "written" }],
				details: { command: { source: "builtin", name: "_write", args: { path: "foo.ts" } } },
			}),
		})];
		const registry = createToolRegistry(tools);

		const executor = registry.get("cli")!;
		const result = await executor.execute({ command: "_write foo.ts hi" });

		expect(result.is_error).toBe(false);
		expect(result.file_mutations).toHaveLength(1);
	});
});
