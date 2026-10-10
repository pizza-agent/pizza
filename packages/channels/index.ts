/**
 * Channels — external message integrations (Discord / Lark / Slack / Telegram /
 * webhook). The registry below is the single place a platform is wired in;
 * platform SDKs are imported lazily inside each adapter's `start`, so loading
 * this module (e.g. in the gateway for validate/probe) stays cheap.
 */

import discord from "./discord.js";
import lark from "./lark.js";
import { ChannelRuntime } from "./runtime.js";
import slack from "./slack.js";
import telegram from "./telegram.js";
import type { ChannelAdapter, ChannelConfig, ChannelType } from "./types.js";
import webhook from "./webhook.js";

export type { ChannelAdapter, ChannelConfig, ChannelType, ProbeResult, ProxiedFetch } from "./types.js";

export const channelAdapters: Record<ChannelType, ChannelAdapter> = { discord, lark, slack, telegram, webhook };

/** Adapter for `type`, or undefined for an unknown type. */
export function channelAdapter(type: string): ChannelAdapter | undefined {
	return Object.hasOwn(channelAdapters, type) ? channelAdapters[type as ChannelType] : undefined;
}

/**
 * Run one channel in this process until SIGINT/SIGTERM: connect to the
 * gateway, start the platform adapter, and tear both down gracefully.
 */
export async function runChannel(config: ChannelConfig, agentDir: string): Promise<void> {
	const adapter = channelAdapter(config.type);
	if (!adapter) throw new Error(`Unknown channel type "${String(config.type)}"`);
	const error = adapter.validate(config);
	if (error) throw new Error(error);

	const runtime = new ChannelRuntime({ agentDir });
	await runtime.start();
	const stopAdapter = await adapter.start(config, runtime);

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[channel] ${signal} received, shutting down…`);
		await stopAdapter().catch(() => {});
		await runtime.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
