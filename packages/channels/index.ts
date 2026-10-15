/**
 * Channels — external message integrations (Discord / Lark / Slack / Telegram /
 * webhook). The registry below is the single place a platform is wired in;
 * platform SDKs are imported lazily inside each adapter's `start`, so loading
 * this module (e.g. in the gateway for validate/probe) stays cheap. Adapters
 * always run inside the gateway daemon via {@link runChannel} — the
 * ChannelBridge carries deliveries/events as direct calls, no subprocesses
 * and no socket round-trips.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import discord from "./discord.js";
import lark from "./lark.js";
import { ChannelRuntime, type ChannelBridge } from "./runtime.js";

export type { ChannelBridge, ChannelRuntimeOptions } from "./runtime.js";
export { routeFetchThroughProxy, routeHttpsThroughProxy } from "./runtime.js";
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

/** Validate + claim the single-instance pidfile. Returns the release fn. */
function claimAdapterSlot(config: ChannelConfig, agentDir: string, override?: ChannelAdapter): () => void {
	const adapter = override ?? channelAdapter(config.type);
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
	return () => {
		try { unlinkSync(pidPath); } catch { /* already gone */ }
	};
}

/**
 * Run one channel inside the calling process (the gateway daemon) until
 * stopped: claim the single-instance slot, subscribe to the event bridge,
 * and start the platform adapter.
 *
 * Returns a stop() for the adapter only. `onFatal` reports platform failures
 * the adapter can't recover from (a dead polling loop) so the supervisor can
 * schedule a respawn — adapters must NEVER process.exit inside the daemon.
 */
export async function runChannel(
	config: ChannelConfig,
	agentDir: string,
	bridge: ChannelBridge,
	onFatal: (error: unknown) => void,
	adapterOverride?: ChannelAdapter,
): Promise<() => Promise<void>> {
	const release = claimAdapterSlot(config, agentDir, adapterOverride);
	const adapter = adapterOverride ?? channelAdapter(config.type)!;
	const runtime = new ChannelRuntime({ agentDir, bridge, onFatal });
	try {
		await runtime.start();
		const stopAdapter = await adapter.start(config, runtime);
		return async () => {
			release();
			await stopAdapter().catch(() => {});
			await runtime.stop().catch(() => {});
		};
	} catch (err) {
		release();
		await runtime.stop().catch(() => {});
		throw err;
	}
}
