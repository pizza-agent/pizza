/**
 * Channels — external message integrations (Discord, Lark, Slack, Telegram,
 * webhooks) that deliver inbound messages into a workspace agent and relay its
 * replies back out.
 *
 * ⚠️ MOCK BACKEND: the gateway has no channel-config RPC yet. These functions
 * are persisted to localStorage so the Channels tab is fully interactive in the
 * desktop UI today. Each one maps 1:1 to the future gateway RPC (noted inline),
 * so wiring the real backend is a drop-in: replace the localStorage body with a
 * `sendCommandAwait({ type: "list_channels" })` (or Tauri `invoke`) call.
 *
 * The on-wire shape mirrors packages/gateway/protocol.ts MessageSource: each
 * channel delivers with `kind = config.type` so the agent sees a uniform
 * `<message from="discord:#dev-alerts">` provenance block.
 */

import { listWorkspaces } from "./transport";
import { pathBasename } from "./platform";

// ── Types ────────────────────────────────────────────────────────────────

/** The integration kinds a channel can be. Open set — add a value + a field
 *  branch in ChannelDialog and it just works. */
export type ChannelType = "discord" | "lark" | "slack" | "telegram" | "webhook";

/** Connection state surfaced in the card's status badge + dot. */
export type ChannelStatus = "connected" | "disconnected" | "error" | "configuring";

/** A persisted channel configuration (no live state). */
export interface ChannelConfig {
	id: string;
	type: ChannelType;
	/** User-facing label, e.g. "Dev alerts". */
	name: string;
	enabled: boolean;
	/** Credential, stored locally for the mock (real backend → auth-storage). */
	token?: string;
	/** Discord guild / Lark tenant. */
	server?: string;
	/** Discord channel / Lark chat / Slack channel name. */
	channel?: string;
	/** webhook type only. */
	webhookUrl?: string;
	/** Target workspace cwd the inbound messages route to. */
	workspace: string;
}

/** ChannelConfig + live connection state, what the list view renders. */
export interface ChannelInfo extends ChannelConfig {
	status: ChannelStatus;
	/** Epoch ms of the last inbound/outbound message, for the card footer. */
	lastMessageAt?: number;
	/** Populated when status === "error". */
	lastError?: string;
}

export const CHANNEL_TYPES: ChannelType[] = ["discord", "lark", "slack", "telegram", "webhook"];

/** Whether a channel type authenticates with a token (vs. a webhook URL). */
export function isTokenType(type: ChannelType): boolean {
	return type !== "webhook";
}

// ── Mock store (localStorage) ────────────────────────────────────────────

const STORAGE_KEY = "pizza.channels.v1";

function newId(): string {
	return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Seed data shown on first visit so the tab isn't empty in a demo. */
function seed(): ChannelInfo[] {
	return [
		{
			id: newId(),
			type: "discord",
			name: "Dev alerts",
			enabled: true,
			token: "••••••••",
			server: "pizza-hq",
			channel: "#dev-alerts",
			workspace: "", // bound lazily once workspaces load
			status: "configuring",
		},
	];
}

function readStore(): ChannelInfo[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			const s = seed();
			localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
			return s;
		}
		return JSON.parse(raw) as ChannelInfo[];
	} catch {
		return [];
	}
}

function writeStore(channels: ChannelInfo[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
}

/** A short artificial delay so loading/test states are visible and feel real. */
function delay<T>(value: T, ms = 250): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ── Transport functions (each → a future gateway RPC) ────────────────────

/** Future: sendCommandAwait<{ type: "list_channels" }> → { channels } */
export async function listChannels(): Promise<ChannelInfo[]> {
	return delay(readStore());
}

export interface ChannelInput {
	type: ChannelType;
	name: string;
	token?: string;
	server?: string;
	channel?: string;
	webhookUrl?: string;
	workspace: string;
	enabled: boolean;
}

/**
 * Future: sendCommandAwait<{ type: "save_channel", channel: input, id? }>
 * Creates or updates. On save the channel is treated as freshly configured
 * (status "configuring" → run `testChannel` to flip it to connected).
 */
export async function saveChannel(id: string | null, input: ChannelInput): Promise<ChannelInfo> {
	const channels = readStore();
	if (id) {
		const idx = channels.findIndex((c) => c.id === id);
		if (idx === -1) throw new Error("Channel not found");
		const updated: ChannelInfo = { ...channels[idx], ...input, status: "configuring", lastError: undefined };
		channels[idx] = updated;
		writeStore(channels);
		return delay(updated);
	}
	const created: ChannelInfo = { id: newId(), ...input, status: "configuring" };
	channels.push(created);
	writeStore(channels);
	return delay(created);
}

/** Future: sendCommandAwait<{ type: "delete_channel", id }> */
export async function deleteChannel(id: string): Promise<void> {
	const channels = readStore().filter((c) => c.id !== id);
	writeStore(channels);
	return delay(undefined);
}

/** Future: sendCommandAwait<{ type: "set_channel_enabled", id, enabled }> */
export async function setChannelEnabled(id: string, enabled: boolean): Promise<ChannelInfo> {
	const channels = readStore();
	const idx = channels.findIndex((c) => c.id === id);
	if (idx === -1) throw new Error("Channel not found");
	// Disabling drops a connected channel to "disconnected" until re-enabled.
	const next: ChannelStatus = enabled ? channels[idx].status : "disconnected";
	channels[idx] = { ...channels[idx], enabled, status: next };
	writeStore(channels);
	return delay(channels[idx]);
}

export interface ChannelTestResult {
	ok: boolean;
	message: string;
}

/**
 * Future: sendCommandAwait<{ type: "test_channel", id }> — like the provider
 * "test connection" flow. Mock: validates a token/url is present, then flips
 * status to connected/disconnected.
 */
export async function testChannel(id: string): Promise<ChannelTestResult> {
	const channels = readStore();
	const idx = channels.findIndex((c) => c.id === id);
	if (idx === -1) throw new Error("Channel not found");
	const c = channels[idx];
	const hasCred = isTokenType(c.type) ? !!c.token?.trim() : !!c.webhookUrl?.trim();
	const ok = hasCred;
	channels[idx] = {
		...c,
		status: ok ? "connected" : "error",
		lastError: ok ? undefined : isTokenType(c.type) ? "Missing token" : "Missing webhook URL",
	};
	writeStore(channels);
	return delay({ ok, message: ok ? "Connection successful" : channels[idx].lastError ?? "Connection failed" }, 900);
}

// ── Helpers for the UI ───────────────────────────────────────────────────

/**
 * Resolve the workspace cwd options for the "deliver to" dropdown. Wraps the
 * real listWorkspaces(); when none exist (e.g. web preview without Tauri) the
 * dialog shows a hint instead of an empty dropdown.
 */
export async function workspaceOptions(): Promise<{ value: string; label: string; hint: string }[]> {
	const workspaces = await listWorkspaces();
	return workspaces.map((ws) => {
		const name = pathBasename(ws.cwd);
		return { value: ws.cwd, label: name, hint: ws.cwd };
	});
}

/** Format "active 3m ago" / "no activity" for the card footer. */
export function formatLastActivity(ms: number | undefined, labels: { ago: (s: string) => string; never: string }): string {
	if (!ms) return labels.never;
	const sec = Math.floor((Date.now() - ms) / 1000);
	if (sec < 60) return labels.ago(`${sec}s`);
	const min = Math.floor(sec / 60);
	if (min < 60) return labels.ago(`${min}m`);
	const hr = Math.floor(min / 60);
	if (hr < 24) return labels.ago(`${hr}h`);
	return labels.ago(`${Math.floor(hr / 24)}d`);
}
