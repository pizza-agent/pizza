/**
 * `pizza update` — check for a newer release and tell the user how to get it.
 *
 * Queries the registry matching the install channel (npm registry for
 * npm/pnpm/yarn/bun installs, GitHub releases for the standalone binary) and
 * prints the result. Also manages the `autoUpdateCheck` setting.
 *
 * Usage:
 *   pizza update              # check now (bypasses cache)
 *   pizza update enable       # enable automatic update checks on startup
 *   pizza update disable      # disable automatic update checks
 */
import chalk from "chalk";
import { getAgentDir } from "./config.js";
import { SettingsManager } from "./core/settings-manager.js";
import { checkForUpdate } from "./core/update-checker.js";

export async function handleUpdateCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "update") {
		return false;
	}
	const rest = args.filter((a) => !a.startsWith("-"));
	// First positional is "update" (the dispatcher token); the subcommand follows.
	const subcommand = rest[1]?.toLowerCase();

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);

	switch (subcommand) {
		case undefined:
		case "check": {
			const result = await checkForUpdate({ force: true });
			if (!result) {
				console.log(chalk.dim("Could not check for updates (offline or registry unreachable)."));
				console.log(chalk.dim(`Releases: https://github.com/pizza-agent/pizza/releases`));
				return true;
			}
			if (!result.updateAvailable) {
				console.log(chalk.green(`You are on the latest version (${result.currentVersion}, via ${result.source}).`));
				return true;
			}
			console.log(chalk.yellow(`Update available: ${result.currentVersion} → ${result.latestVersion}`));
			console.log(`  ${chalk.bold(result.updateInstruction)}`);
			if (result.releaseUrl) {
				console.log(chalk.dim(`  Release notes: ${result.releaseUrl}`));
			}
			return true;
		}
		case "enable":
		case "disable": {
			const enabled = subcommand === "enable";
			settingsManager.setAutoUpdateCheck(enabled);
			console.log(
				enabled
					? chalk.green("Automatic update checks enabled.")
					: chalk.yellow("Automatic update checks disabled."),
			);
			return true;
		}
		default:
			console.error(chalk.red(`Unknown subcommand "${subcommand}". Usage: pizza update [check|enable|disable]`));
			process.exitCode = 1;
			return true;
	}
}