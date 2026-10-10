/**
 * Channel types shared by the gateway supervisor, the `pizza channel run`
 * entry and every platform adapter.
 */

import type { ChannelRuntime } from "./runtime.js";

/** The integration kinds a channel can be. A new platform adds a value here,
 *  an adapter file, and a field branch in the UI ChannelDialog. */
export type ChannelType = "discord" | "lark" | "slack" | "telegram" | "webhook";

/** A persisted channel config (`<agentDir>/channels.json`) — mirrors
 *  apps/web/src/lib/channels.ts ChannelConfig. */
export interface ChannelConfig {
	id: string;
	type: ChannelType;
	/** User-facing label. */
	name: string;
	enabled: boolean;
	/** Platform credential (bot token; webhook shared secret). */
	token?: string;
	appId?: string;
	appSecret?: string;
	/** Slack app-level token for Socket Mode (xapp-…). */
	appToken?: string;
	server?: string;
	channel?: string;
	/** webhook type only — the address to listen on. */
	webhookUrl?: string;
	/** Target pizza workspace (cwd or name) that inbound messages route to. */
	workspace: string;
}

export interface ProbeResult {
	ok: boolean;
	message: string;
}

/** `fetch` already routed through the configured proxy. */
export type ProxiedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One platform integration. `validate` and `probe` run inside the gateway
 * (UI save / Test button), `start` runs in the adapter process spawned by the
 * supervisor — so platform SDKs must only be imported (dynamically) in `start`.
 */
export interface ChannelAdapter {
	/** Platform-specific save validation. Returns an error string, or null. */
	validate(config: Partial<ChannelConfig>): string | null;
	/** Real credential check — the same call the adapter makes at boot. */
	probe(config: ChannelConfig, fetch: ProxiedFetch): Promise<ProbeResult>;
	/** Connect to the platform and relay messages; resolves with a `stop()`. */
	start(config: ChannelConfig, runtime: ChannelRuntime): Promise<() => Promise<void>>;
}
