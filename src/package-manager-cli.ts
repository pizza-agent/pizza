import chalk from "chalk";
import { selectConfig } from "../packages/cli/config-selector.js";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions/index.js";
import { APP_NAME, getAgentDir } from "./config.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { SettingsManager } from "./core/settings-manager.js";

export type PackageCommand = "install" | "remove" | "update" | "list" | "enable" | "disable";

const PACKAGE_COMMANDS: readonly PackageCommand[] = ["install", "remove", "update", "list", "enable", "disable"];

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	help: boolean;
	invalidOption?: string;
	/** `-l/--local` was passed: project-level plugins are no longer supported. */
	local: boolean;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} plugin install <source>`;
		case "remove":
			return `${APP_NAME} plugin remove <source>`;
		case "update":
			return `${APP_NAME} plugin update [source]`;
		case "list":
			return `${APP_NAME} plugin list`;
		case "enable":
			return `${APP_NAME} plugin enable <source|builtin-id>`;
		case "disable":
			return `${APP_NAME} plugin disable <source|builtin-id>`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a plugin package and record it in ~/.pizza/agent/extensions.json.

Examples:
  ${APP_NAME} plugin install npm:@foo/bar
  ${APP_NAME} plugin install git:github.com/user/repo
  ${APP_NAME} plugin install git:git@github.com:user/repo
  ${APP_NAME} plugin install https://github.com/user/repo
  ${APP_NAME} plugin install ssh://git@github.com/user/repo
  ${APP_NAME} plugin install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Uninstall a plugin package and drop it from extensions.json.
Alias: ${APP_NAME} plugin uninstall <source>

Examples:
  ${APP_NAME} plugin remove npm:@foo/bar
  ${APP_NAME} plugin uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed plugin packages.
If <source> is provided, only that package is updated.
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List built-in plugins and installed plugin packages with their state.
`);
			return;

		case "enable":
		case "disable":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(command)}

${command === "enable" ? "Enable" : "Disable"} a built-in plugin (by id) or an installed plugin package (by source).
Takes effect when a session next loads its resources.

Examples:
  ${APP_NAME} plugin ${command} agent-browser
  ${APP_NAME} plugin ${command} npm:@foo/bar
`);
			return;
	}
}

function printPluginGroupHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} plugin <command> [options]

${chalk.bold("Plugin commands:")}
  install <source>        Install a plugin package
  remove <source>         Uninstall a plugin package
  uninstall <source>      Alias for remove
  update [source]         Update installed plugin packages (skips pinned sources)
  list                    List plugins and their state
  enable <source|id>      Enable a plugin (built-in id or package source)
  disable <source|id>     Disable a plugin (built-in id or package source)

Plugin state is stored in ~/.pizza/agent/extensions.json.

${chalk.bold("Examples:")}
  ${APP_NAME} plugin install npm:@foo/bar
  ${APP_NAME} plugin disable npm:@foo/bar
  ${APP_NAME} plugin update
  ${APP_NAME} plugin list

Run "${APP_NAME} plugin <command> --help" for command-specific help.
`);
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	// Expect: plugin <subcommand> [options...]
	if (args[0] !== "plugin") {
		return undefined;
	}
	const [rawCommand, ...rest] = args.slice(1);
	const command: PackageCommand | undefined =
		rawCommand === "uninstall" ? "remove" : PACKAGE_COMMANDS.find((c) => c === rawCommand);
	if (!command) {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "-l" || arg === "--local") {
			local = true;
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		if (!source) {
			source = arg;
		}
	}

	return { command, source, help, invalidOption, local };
}

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	// Only handle args that start with the "plugin" group.
	if (args[0] !== "plugin") {
		return false;
	}

	const subArgs = args.slice(1);
	const subCommand = subArgs[0];

	// `pizza plugin` with no subcommand, or `pizza plugin --help` → show group help.
	if (!subCommand || subCommand === "-h" || subCommand === "--help") {
		printPluginGroupHelp();
		return true;
	}

	// Unknown plugin subcommand → friendly error.
	const known = [...PACKAGE_COMMANDS, "uninstall"];
	if (!known.includes(subCommand)) {
		console.error(chalk.red(`Unknown plugin command "${subCommand}".`));
		console.error(chalk.dim(`Available commands: ${known.join(", ")}`));
		console.error(chalk.dim(`Use "${APP_NAME} plugin --help" for more information.`));
		process.exitCode = 1;
		return true;
	}

	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.local) {
		console.error(chalk.red("Project-level plugins (-l/--local) are no longer supported."));
		console.error(chalk.dim("Plugins are installed per user and recorded in ~/.pizza/agent/extensions.json."));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if (options.command !== "update" && options.command !== "list" && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!);
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!);
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "enable":
			case "disable": {
				const enabled = options.command === "enable";
				const verb = enabled ? "Enabled" : "Disabled";
				if (BUILTIN_EXTENSIONS.some((ext) => ext.id === source)) {
					settingsManager.setBuiltinExtensionDisabled(source!, !enabled);
					console.log(chalk.green(`${verb} built-in plugin: ${source}`));
					return true;
				}
				if (!packageManager.setPackageEnabled(source!, enabled)) {
					console.error(chalk.red(`No installed plugin matches ${source}. Run "${APP_NAME} plugin list".`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`${verb} ${source}`));
				return true;
			}

			case "list": {
				const disabledBuiltins = settingsManager.getDisabledBuiltinExtensions();
				const state = (enabled: boolean) => (enabled ? chalk.green("enabled") : chalk.red("disabled"));

				console.log(chalk.bold("Built-in plugins:"));
				for (const ext of BUILTIN_EXTENSIONS) {
					const installed = settingsManager.extensions.get(ext.id)?.installed;
					const installState = ext.installable && installed === false ? chalk.dim("  (not installed)") : "";
					console.log(`  ${ext.id.padEnd(20)} ${state(!disabledBuiltins.has(ext.id))}${installState}`);
				}

				const packages = packageManager.listConfiguredPackages();
				console.log();
				if (packages.length === 0) {
					console.log(chalk.dim("No plugin packages installed."));
					return true;
				}
				console.log(chalk.bold("Plugin packages:"));
				for (const pkg of packages) {
					const version = pkg.version ? chalk.dim(` ${pkg.version}`) : "";
					const filtered = pkg.filtered ? chalk.dim(" (filtered)") : "";
					console.log(`  ${pkg.source}${version}${filtered}  ${state(pkg.enabled)}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				}
				return true;
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
