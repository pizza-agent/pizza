/**
 * Channels — external message integrations (Discord / Lark / Slack / Telegram /
 * webhook). The registry below is the single place a platform is wired in;
 * platform SDKs are imported lazily inside each adapter's `start`, so loading
 * this module (e.g. in the gateway for validate/probe) stays cheap.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
/** pidfile path for one channel's adapter — the single-instance lock. */
export function adapterPidPath(agentDir: string, channelId: string): string {
	return join(agentDir, "channels", `${channelId}.pid`);
}

/** Read the pidfile; returns the pid of a LIVE adapter for this channel, or
 *  null when none/stale. Stale files are cleaned up so a crashed adapter
 *  doesn't wedge the channel forever. */
export function liveAdapterPid(agentDir: string, channelId: string): number | null {
	const path = adapterPidPath(agentDir, channelId);
	if (!existsSync(path)) return null;
	try {
		const pid = Number(readFileSync(path, "utf8").trim());
		if (!Number.isInteger(pid) || pid <= 0) throw new Error("bad pidfile");
		process.kill(pid, 0); // throws ESRCH when dead; EPERM still means alive
		return pid;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			return Number(readFileSync(path, "utf8").trim());
		}
		unlinkSync(path); // dead or corrupt — clean up
		return null;
	}
}

export async function runChannel(config: ChannelConfig, agentDir: string): Promise<void> {
	const adapter = channelAdapter(config.type);
	if (!adapter) throw new Error(`Unknown channel type "${String(config.type)}"`);
	const error = adapter.validate(config);
	if (error) throw new Error(error);

	// Single-instance guard: platform websockets load-balance events across
	// every live connection, so a second adapter for the same channel would
	// split (or double) deliveries. Exit rather than compete.
	const pidPath = adapterPidPath(agentDir, config.id);
	const existing = liveAdapterPid(agentDir, config.id);
	if (existing && existing !== process.pid) {
		throw new Error(`channel ${config.id} already has a live adapter (pid ${existing})`);
	}
	mkdirSync(join(agentDir, "channels"), { recursive: true });
	writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
	const release = (): void => {
		try { unlinkSync(pidPath); } catch { /* already gone */ }
	};

	const runtime = new ChannelRuntime({ agentDir });
	await runtime.start();
	const stopAdapter = await adapter.start(config, runtime);

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[channel] ${signal} received, shutting down…`);
		release();
		await stopAdapter().catch(() => {});
		await runtime.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("exit", release);
}
