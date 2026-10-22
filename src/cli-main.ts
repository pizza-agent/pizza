/**
 * CLI entry point for the coding agent.
 * Routes read/write/edit built-in commands to builtin-commands.ts.
 * grep, find, ls are not built-in commands — they are passed to the system shell.
 * and passes other commands to main.ts.
 * Loaded dynamically by cli.ts — see that file for why this is not a
 * static import chain.
 */
import { writeFileSync } from "node:fs";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { executeCompatCommand, COMPAT_COMMANDS } from "./core/tools/compat-commands.js";
import { executeBuiltinCommand, BUILTIN_COMMANDS } from "./core/tools/builtin-commands.js";
import { main } from "./main.js";
import { cliArguments } from "../packages/cli/argv.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

function writeCompatOutput(fd: 1 | 2, text: string): void {
	if (!text) return;
	try {
		writeFileSync(fd, text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
	}
}
// Check if this is a built-in command call
const args = cliArguments(process.argv, process.execArgv);
const BUILTIN_EXTENSION_SUBCOMMANDS = new Set(["list", "enable", "disable"]);
// `pizza builtin list|enable|disable` manages built-in EXTENSIONS (in main.ts),
// not the built-in CLI commands (_read/_write/_edit/…). Route those to main() so
// cli.ts's built-in-command handling does not intercept them.
const isBuiltinExtensionCommand =
	args[0] === "builtin" && BUILTIN_EXTENSION_SUBCOMMANDS.has(args[1]);

if (args[0] === "__compat" && args.length >= 2) {
	const command = args[1];
	if (!COMPAT_COMMANDS.includes(command as any)) {
		console.error(`Unknown compat command: ${command}`);
		console.error(`Available compat commands: ${COMPAT_COMMANDS.join(", ")}`);
		process.exit(2);
	}

	const result = await executeCompatCommand(command, args.slice(2), { cwd: process.cwd() });
	writeCompatOutput(1, result.stdout);
	writeCompatOutput(2, result.stderr);
	process.exitCode = result.exitCode;
} else if (args[0] === "builtin" && args.length >= 2 && !isBuiltinExtensionCommand) {
	const command = args[1] as typeof BUILTIN_COMMANDS[number];

	if (!BUILTIN_COMMANDS.includes(command)) {
		console.error(`Unknown builtin command: ${command}`);
		console.error(`Available commands: ${BUILTIN_COMMANDS.join(", ")}`);
		process.exit(1);
	}

	const commandArgs = args.slice(2);
	const cwd = process.cwd();

	executeBuiltinCommand(command, commandArgs, { cwd })
		.then((result) => {
			if (result.stdout) {
				console.log(result.stdout);
			}
			if (result.stderr) {
				console.error(result.stderr);
			}
			process.exit(result.exitCode);
		})
		.catch((error) => {
			console.error(`Error executing builtin command: ${error.message}`);
			process.exit(1);
		});
} else {
	main(args);
}
