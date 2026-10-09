/**
 * Channels — external message integrations (Discord, Lark, Slack, Telegram,
 * webhooks) that deliver inbound messages into a workspace agent and relay its
 * replies back out.
 *
 * In Tauri these call the gateway's `channel_op` Layer-1 message via the Rust
 * bridge — the gateway's ChannelSupervisor persists configs and spawns one
 * adapter process per enabled channel, so "connected" means the adapter is
 * actually running. The browser dev preview has no gateway, so it falls back
 * to a localStorage mock purely to keep the tab interactive.
 *
 * The on-wire shape mirrors packages/gateway/protocol.ts MessageSource: each
 * channel delivers with `kind = config.type` so the agent sees a uniform
 * `<message from="discord:#dev-alerts">` provenance block.
 */

import { listWorkspaces } from "./transport";
import { isMainChatCwd, isTauri, MAIN_CHAT_CWD, pathBasename } from "./platform";

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
	/** Lark/Feishu app credentials (LARK_APP_ID / LARK_APP_SECRET). */
	appId?: string;
	appSecret?: string;
	/** Discord guild. */
	server?: string;
	/** Discord channel / Slack channel name. */
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

/** Which credential fields a channel type needs. Every inbound message routes
 *  to the configured workspace — guild/server scoping and per-channel routing
 *  are adapter-level concerns (PIZZA_ROUTES), not user-facing fields. */
export interface ChannelFieldSpec {
	appCredentials?: boolean;
	token?: boolean;
	webhook?: boolean;
}

export function channelFieldSpec(type: ChannelType): ChannelFieldSpec {
	switch (type) {
		case "lark":
			return { appCredentials: true };
		case "webhook":
			return { webhook: true };
		default:
			return { token: true };
	}
}

// ── Real backend (Tauri → gateway channel_op) ────────────────────────────

/** Send a channel-management op through the Rust bridge to the gateway.
 *  Rejects with the gateway's error string on failure. */
async function channelOp<T = unknown>(request: Record<string, unknown>): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>("channel_op", { request });
}

// ── Mock store (localStorage, browser fallback only) ─────────────────────

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

export async function listChannels(): Promise<ChannelInfo[]> {
	if (isTauri()) {
		const res = await channelOp<{ channels: ChannelInfo[] }>({ action: "list" });
		return res.channels;
	}
	return delay(readStore());
}

export interface ChannelInput {
	type: ChannelType;
	name: string;
	token?: string;
	appId?: string;
	appSecret?: string;
	server?: string;
	channel?: string;
	webhookUrl?: string;
	workspace: string;
	enabled: boolean;
}

/**
 * Creates or updates a channel. The gateway persists it and (re)spawns the
 * adapter when enabled — the returned info carries the live status.
 */
export async function saveChannel(id: string | null, input: ChannelInput): Promise<ChannelInfo> {
	if (isTauri()) {
		const res = await channelOp<{ channel: ChannelInfo }>({
			action: "save",
			channelId: id ?? undefined,
			channel: input,
		});
		return res.channel;
	}
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

export async function deleteChannel(id: string): Promise<void> {
	if (isTauri()) {
		await channelOp({ action: "delete", channelId: id });
		return;
	}
	const channels = readStore().filter((c) => c.id !== id);
	writeStore(channels);
	return delay(undefined);
}

export async function setChannelEnabled(id: string, enabled: boolean): Promise<ChannelInfo> {
	if (isTauri()) {
		const res = await channelOp<{ channel: ChannelInfo }>({ action: "set_enabled", channelId: id, enabled });
		return res.channel;
	}
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
 * Like the provider "test connection" flow — in Tauri this is a real
 * credential probe (e.g. Lark tenant_access_token, Discord users/@me).
 */
export async function testChannel(id: string): Promise<ChannelTestResult> {
	if (isTauri()) {
		return channelOp<ChannelTestResult>({ action: "test", channelId: id });
	}
	const channels = readStore();
	const idx = channels.findIndex((c) => c.id === id);
	if (idx === -1) throw new Error("Channel not found");
	const c = channels[idx];
	const spec = channelFieldSpec(c.type);
	const hasCred = spec.webhook
		? !!c.webhookUrl?.trim()
		: spec.appCredentials
			? !!(c.appId?.trim() && c.appSecret?.trim())
			: !!c.token?.trim();
	const ok = hasCred;
	const missing = spec.webhook ? "Missing webhook URL" : spec.appCredentials ? "Missing app credentials" : "Missing token";
	channels[idx] = {
		...c,
		status: ok ? "connected" : "error",
		lastError: ok ? undefined : missing,
	};
	writeStore(channels);
	return delay({ ok, message: ok ? "Connection successful" : channels[idx].lastError ?? "Connection failed" }, 900);
}

// ── Helpers for the UI ───────────────────────────────────────────────────

/**
 * Resolve the workspace cwd options for the "deliver to" dropdown. Wraps the
 * real listWorkspaces(); the persistent main assistant (~/.pizza/main) is
 * pinned first and flagged `main` so the dialog can render it with the same
 * name the sidebar uses (layout.agent). When no workspaces exist (e.g. web
 * preview without Tauri) main is still offered — it always exists.
 */
export interface WorkspaceOption {
	value: string;
	label: string;
	hint: string;
	/** The persistent main assistant — label/hint come from layout.agent i18n. */
	main?: boolean;
}

export async function workspaceOptions(): Promise<WorkspaceOption[]> {
	const workspaces = await listWorkspaces();
	const options = workspaces
		.filter((ws) => !isMainChatCwd(ws.cwd))
		.map((ws) => {
			const name = pathBasename(ws.cwd);
			return { value: ws.cwd, label: name, hint: ws.cwd };
		});
	return [{ value: MAIN_CHAT_CWD, label: "", hint: "", main: true }, ...options];
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
