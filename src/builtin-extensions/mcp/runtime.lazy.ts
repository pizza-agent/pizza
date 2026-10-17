import type * as McpRuntime from "./runtime.js";

let loaded: Promise<typeof McpRuntime> | undefined;

export function loadMcpRuntime(): Promise<typeof McpRuntime> {
	loaded ??= import("./runtime.js");
	return loaded;
}