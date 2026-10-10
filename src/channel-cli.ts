/**
 * `pizza channel` subcommand — run a message-channel adapter.
 *
 *   pizza channel run <id> [--agent-dir <dir>]
 *
 * Runs the channel `<id>` from `<agentDir>/channels.json` in the foreground.
 * The gateway's channel supervisor spawns exactly this for every enabled
 * channel, so "configured in the UI" and "run by hand" stay identical.
 */

import chalk from "chalk";
import { loadChannelConfigs } from "../packages/gateway/channel-supervisor.js";
import { getAgentDir } from "./config.js";

function printHelp(): void {
	console.log(`${chalk.bold("pizza channel")} — run a message-channel adapter

${chalk.bold("Usage:")}
  pizza channel run <id> [--agent-dir <dir>]

Runs channel <id> from <agentDir>/channels.json (configured in the Channels tab)
in the foreground. The gateway normally runs enabled channels for you.
`);
}

export async function handleChannelCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "channel") return false;
	if (args[1] !== "run" || !args[2] || args[2].startsWith("-")) {
		printHelp();
		process.exitCode = args[1] === undefined || args[1] === "--help" || args[1] === "-h" ? 0 : 1;
		return true;
	}

	const id = args[2];
	const flag = args.indexOf("--agent-dir");
	const agentDir = flag !== -1 && args[flag + 1] ? args[flag + 1] : getAgentDir();
	const config = loadChannelConfigs(agentDir).find((c) => c.id === id);
	if (!config) {
		console.error(chalk.red(`Channel "${id}" not found in ${agentDir}/channels.json`));
		process.exit(1);
	}

	const { runChannel } = await import("../packages/channels/index.js");
	try {
		await runChannel(config, agentDir);
	} catch (error) {
		console.error(`[${config.type}] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	return true;
}
