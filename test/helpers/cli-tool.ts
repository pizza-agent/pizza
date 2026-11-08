/**
 * Test helper: build the unified `cli` tool the way `createBashTool` used to.
 * Shell fallback is enabled by default; per-command options (skill/cron/tell/
 * file command overrides) and a dynamic extension-command list can be supplied.
 */
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.js";
import {
	createBuiltinCliCommands,
	type BuiltinCliCommandOptions,
} from "../../src/core/tools/builtin-cli-commands.js";
import { CommandRegistry } from "../../src/core/tools/command-registry.js";
import { createCliToolDefinition } from "../../src/core/tools/cli.js";
import type {
	BashOperations,
	BashSpawnHook,
	ShellOptions,
} from "../../src/core/tools/shell.js";
import type {
	CliCommandDefinition,
	RegisteredCliCommand,
} from "../../src/core/extensions/types.js";
import type { AgentTool } from "../../src/core/extensions/types.js";

export interface CliTestToolOptions extends BuiltinCliCommandOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	shellPath?: string;
	spawnHook?: BashSpawnHook;
	/** Extra shell options; pass `false` to disable the shell fallback entirely. */
	shell?: Omit<ShellOptions, "operations" | "commandPrefix" | "shellPath" | "spawnHook"> | false;
	dynamicBuiltins?: () => CliCommandDefinition[];
}

export function createCliTestToolDefinition(cwd: string, options: CliTestToolOptions = {}) {
	const registry = new CommandRegistry({
		builtins: createBuiltinCliCommands(cwd, options),
		extensions: () => (options.dynamicBuiltins?.() ?? []) as RegisteredCliCommand[],
	});
	const shell: ShellOptions | undefined =
		options.shell === false
			? undefined
			: {
					operations: options.operations,
					commandPrefix: options.commandPrefix,
					shellPath: options.shellPath,
					spawnHook: options.spawnHook,
					...(typeof options.shell === "object" ? options.shell : {}),
				};
	return createCliToolDefinition(cwd, { registry, shell });
}

export function createCliTestTool(cwd: string, options: CliTestToolOptions = {}): AgentTool {
	return wrapToolDefinition(createCliTestToolDefinition(cwd, options));
}
