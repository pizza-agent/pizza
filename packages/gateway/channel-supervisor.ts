/**
 * Channel supervisor — the gateway-side owner of message-channel integrations
 * (Discord / Lark / Slack / Telegram / webhook).
 *
 * The Channels tab in the desktop UI saves a config per integration; this
 * module persists those configs (`<agentDir>/channels.json`), spawns one
 * adapter process per ENABLED channel (`@tomsun28/pizza-channel-<type>`), and
 * reports live status back so the UI badge means something real:
 *
 *   UI ──channel_op──▶ gateway ──▶ supervisor ──spawn──▶ adapter process ──tell──▶ gateway (again)
 *
 * The supervisor intentionally reuses the adapters' existing env-var contract
 * (LARK_APP_ID, DISCORD_TOKEN, PIZZA_WORKSPACE, …) — an adapter is a plain
 * node process, so "configured in the UI" and "run by hand" stay identical.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";

export type ManagedChannelType = "discord" | "lark" | "slack" | "telegram" | "webhook";
export type ManagedChannelStatus = "connected" | "disconnected" | "error" | "configuring";

/** A persisted channel config — mirrors apps/web/src/lib/channels.ts ChannelConfig. */
export interface ManagedChannelConfig {
	id: string;
	type: ManagedChannelType;
	name: string;
	enabled: boolean;
	token?: string;
	appId?: string;
	appSecret?: string;
	/** Slack app-level token for Socket Mode (xapp-…). */
	appToken?: string;
	server?: string;
	channel?: string;
	webhookUrl?: string;
	workspace: string;
}

/** What `list` returns — config + live process state. */
export interface ManagedChannelInfo extends ManagedChannelConfig {
	status: ManagedChannelStatus;
	lastError?: string;
	lastMessageAt?: number;
}

interface RuntimeEntry {
	config: ManagedChannelConfig;
	child?: ChildProcess;
	/** Set when the adapter failed to spawn or exited. */
	lastError?: string;
	/** Rolling stderr/stdout tail — surfaced as lastError context. */
	tail: string;
}

const TAIL_LIMIT = 8 * 1024;

function newId(): string {
	return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Resolve the adapter package's entry point (`dist/index.js`). The channel
 * packages are NOT dependencies of the gateway — they resolve only when
 * installed alongside (monorepo workspaces, or a user-installed package).
 * Returns null when the package can't be resolved.
 */
function resolveAdapterEntry(type: ManagedChannelType): string | null {
	try {
		const url = import.meta.resolve(`@tomsun28/pizza-channel-${type}`);
		if (!url.startsWith("file:")) return null;
		return fileURLToPath(url);
	} catch {
		return null;
	}
}

/** The node binary to run adapters with. Under a compiled pizza binary
 *  process.execPath IS pizza (can't run a JS file) — fall back to `node`
 *  on PATH; PIZZA_NODE overrides. */
function nodeBin(): string {
	if (process.env.PIZZA_NODE) return process.env.PIZZA_NODE;
	return /node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
}

/** systemProxy() returns a URL, `false` for a user-disabled proxy ("off" in
 *  settings.json — also strips proxy vars inherited from the gateway's env),
 *  or undefined when nothing was detected. */
type ProxyResolution = string | false | undefined;

let detectedProxy: string | null | undefined; // undefined = not probed yet

/** The user's configured proxy from `<agentDir>/settings.json`
 *  (`network.proxy`). Read fresh each call — spawning an adapter should pick
 *  up the latest setting, not a value cached at gateway start. */
function configuredProxy(agentDir: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
			network?: { proxy?: unknown };
		};
		const proxy = raw.network?.proxy;
		return typeof proxy === "string" && proxy.trim() ? proxy.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Proxy the adapters should use to reach platform APIs. Resolution order:
 *   1. settings.json `network.proxy` — explicit URL wins, "off" disables
 *   2. proxy env vars already present on the gateway process
 *   3. the macOS system proxy (`scutil --proxy`)
 * Telegram/Discord/Slack endpoints are unreachable on some networks — when
 * the gateway runs as a desktop daemon the shell's proxy env is absent, so
 * the OS setting is the only usable hint. Detection results are cached for
 * the process lifetime (the configured value is not — see configuredProxy).
 */
function systemProxy(agentDir: string): ProxyResolution {
	const configured = configuredProxy(agentDir);
	if (configured === "off") return false;
	if (configured && configured !== "auto") return configured;
	if (detectedProxy !== undefined) return detectedProxy ?? undefined;
	detectedProxy = null;
	const envProxy =
		process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
	if (envProxy) {
		detectedProxy = envProxy;
	} else if (process.platform === "darwin") {
		try {
			const out = execSync("scutil --proxy", { encoding: "utf8", timeout: 3000 });
			if (/HTTPSEnable\s*:\s*1/.test(out)) {
				const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
				const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
				if (host && port) detectedProxy = `http://${host}:${port}`;
			}
		} catch {
			/* scutil missing/failed — no proxy */
		}
	}
	return detectedProxy ?? undefined;
}

/** Proxy env var names — stripped from the child env when the user turns the
 *  proxy off, so a proxied shell that launched the gateway can't leak through. */
const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

/** Translate a UI config into the adapter's env contract. */
function envFor(config: ManagedChannelConfig, agentDir: string): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	env.PIZZA_WORKSPACE = config.workspace;
	const proxy = systemProxy(agentDir);
	if (proxy === false) {
		for (const name of PROXY_ENV_VARS) delete env[name];
	} else if (proxy) {
		env.HTTPS_PROXY ??= proxy;
		env.https_proxy ??= proxy;
		env.HTTP_PROXY ??= proxy;
		env.http_proxy ??= proxy;
	}
	// A configured channel/chat becomes a PIZZA_ROUTES entry — same syntax the
	// adapters accept by hand ("#target=workspace"). Lark chat ids and Discord
	// channel names both tolerate the leading "#".
	const route = config.channel?.trim();
	if (route && config.type !== "webhook") {
		env.PIZZA_ROUTES = `${route.startsWith("#") ? route : `#${route}`}=${config.workspace}`;
	}
	switch (config.type) {
		case "lark":
			env.LARK_APP_ID = config.appId ?? "";
			env.LARK_APP_SECRET = config.appSecret ?? "";
			break;
		case "discord":
			env.DISCORD_TOKEN = config.token ?? "";
			break;
		case "telegram":
			env.TELEGRAM_BOT_TOKEN = config.token ?? "";
			break;
		case "slack":
			env.SLACK_BOT_TOKEN = config.token ?? "";
			env.SLACK_APP_TOKEN = config.appToken ?? "";
			break;
		case "webhook":
			env.WEBHOOK_TOKEN = config.token ?? "";
			if (config.webhookUrl) {
				try {
					const port = new URL(config.webhookUrl).port;
					if (port) env.PORT = port;
				} catch {
					/* unparsable — keep the adapter default */
				}
			}
			break;
	}
	return env;
}

/** Validate a save input. Returns an error string, or null when valid. */
function validate(input: Partial<ManagedChannelConfig>): string | null {
	if (!input.name?.trim()) return "Display name is required";
	if (!input.workspace?.trim()) return "Select a workspace";
	switch (input.type) {
		case "lark":
			if (!input.appId?.trim()) return "App ID is required";
			if (!input.appSecret?.trim()) return "App Secret is required";
			return null;
		case "webhook":
			if (!input.webhookUrl?.trim()) return "Webhook URL is required";
			return null;
		case "slack":
			if (!input.token?.trim()) return "Bot token is required";
			if (!input.appToken?.trim()) return "App-level token (xapp-…) is required — enable Socket Mode first";
			return null;
		case "discord":
		case "telegram":
			if (!input.token?.trim()) return "Bot token is required";
			return null;
		default:
			return `Unknown channel type "${String(input.type)}"`;
	}
}

/**
 * Real credential check per platform — same call the adapter makes at boot
 * (Lark: tenant_access_token; Discord: users/@me; Telegram: getMe; Slack:
 * auth.test). Webhook is inbound-only: the URL just has to parse.
 */
async function probeCredentials(
	config: ManagedChannelConfig,
	agentDir: string,
): Promise<{ ok: boolean; message: string }> {
	// Mirror the adapter's network path — the spawned adapter gets the proxy
	// via env, the probe (global fetch) gets it via an explicit dispatcher.
	const proxy = systemProxy(agentDir);
	const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
	const proxiedFetch = (url: string, init?: RequestInit) =>
		fetch(url, { ...init, dispatcher } as RequestInit);
	try {
		switch (config.type) {
			case "lark": {
				const res = await proxiedFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
					signal: AbortSignal.timeout(10_000),
				});
				const body = (await res.json()) as { code?: number; msg?: string };
				return body.code === 0
					? { ok: true, message: "App credentials are valid" }
					: { ok: false, message: `Feishu rejected the credentials: ${body.msg ?? `code ${body.code}`}` };
			}
			case "discord": {
				const res = await proxiedFetch("https://discord.com/api/v10/users/@me", {
					headers: { authorization: `Bot ${config.token}` },
					signal: AbortSignal.timeout(10_000),
				});
				return res.ok
					? { ok: true, message: "Bot token is valid" }
					: { ok: false, message: `Discord rejected the token (HTTP ${res.status})` };
			}
			case "telegram": {
				const res = await proxiedFetch(`https://api.telegram.org/bot${config.token}/getMe`, {
					signal: AbortSignal.timeout(10_000),
				});
				const body = (await res.json()) as { ok?: boolean; description?: string };
				return body.ok === true
					? { ok: true, message: "Bot token is valid" }
					: { ok: false, message: `Telegram rejected the token: ${body.description ?? `HTTP ${res.status}`}` };
			}
			case "slack": {
				const res = await proxiedFetch("https://slack.com/api/auth.test", {
					method: "POST",
					headers: { authorization: `Bearer ${config.token}` },
					signal: AbortSignal.timeout(10_000),
				});
				const body = (await res.json()) as { ok?: boolean; error?: string };
				return body.ok === true
					? { ok: true, message: "Bot token is valid" }
					: { ok: false, message: `Slack rejected the token: ${body.error ?? `HTTP ${res.status}`}` };
			}
			case "webhook":
				try {
					new URL(config.webhookUrl ?? "");
					return { ok: true, message: "Webhook URL is valid" };
				} catch {
					return { ok: false, message: "Webhook URL is not a valid URL" };
				}
		}
	} catch (error) {
		return { ok: false, message: `Connectivity check failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export class ChannelSupervisor {
	private readonly agentDir: string;
	private readonly configPath: string;
	private readonly entries = new Map<string, RuntimeEntry>();
	private settingsWatcher?: FSWatcher;
	private respawnTimer?: NodeJS.Timeout;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.configPath = join(agentDir, "channels.json");
	}

	/** Load persisted configs and spawn every enabled channel. Call at gateway start. */
	start(): void {
		for (const config of this.load()) {
			this.entries.set(config.id, { config, tail: "" });
		}
		for (const entry of this.entries.values()) {
			if (entry.config.enabled) this.spawn(entry);
		}
		// Respawn adapters when settings.json changes so a proxy toggle in the
		// Settings UI takes effect immediately instead of waiting for a manual
		// channel restart. Watch the directory — settings.json may not exist
		// until the first save.
		try {
			this.settingsWatcher = watch(dirname(this.configPath), (_event, filename) => {
				if (filename !== "settings.json") return;
				clearTimeout(this.respawnTimer);
				this.respawnTimer = setTimeout(() => {
					for (const entry of this.entries.values()) {
						if (entry.config.enabled) this.spawn(entry);
					}
				}, 300);
			});
		} catch {
			/* unwatchable dir — proxy changes apply on next manual restart */
		}
	}

	/** Stop every adapter process. Call at gateway shutdown. */
	async shutdown(): Promise<void> {
		this.settingsWatcher?.close();
		clearTimeout(this.respawnTimer);
		for (const entry of this.entries.values()) {
			this.stop(entry);
		}
	}

	private load(): ManagedChannelConfig[] {
		try {
			if (!existsSync(this.configPath)) return [];
			const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
			return Array.isArray(parsed) ? (parsed as ManagedChannelConfig[]) : [];
		} catch {
			return [];
		}
	}

	private persist(): void {
		const configs = Array.from(this.entries.values()).map((e) => e.config);
		mkdirSync(dirname(this.configPath), { recursive: true });
		writeFileSync(this.configPath, JSON.stringify(configs, null, 2));
		// Configs carry app secrets — keep the file owner-only.
		try {
			chmodSync(this.configPath, 0o600);
		} catch {
			/* best effort (e.g. Windows) */
		}
	}

	private toInfo(entry: RuntimeEntry): ManagedChannelInfo {
		const alive = !!entry.child && entry.child.exitCode === null && !entry.child.killed;
		const status: ManagedChannelStatus = !entry.config.enabled
			? "disconnected"
			: alive
				? "connected"
				: entry.lastError
					? "error"
					: "configuring";
		return { ...entry.config, status, lastError: entry.lastError };
	}

	list(): ManagedChannelInfo[] {
		return Array.from(this.entries.values()).map((e) => this.toInfo(e));
	}

	private spawn(entry: RuntimeEntry): void {
		this.stop(entry);
		const { config } = entry;
		const entryPoint = resolveAdapterEntry(config.type);
		if (!entryPoint) {
			entry.lastError = `Adapter package "@tomsun28/pizza-channel-${config.type}" is not installed`;
			return;
		}
		entry.lastError = undefined;
		entry.tail = "";
		let child: ChildProcess;
		try {
			child = spawn(nodeBin(), [entryPoint], {
				env: envFor(config, this.agentDir),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			entry.lastError = error instanceof Error ? error.message : String(error);
			return;
		}
		entry.child = child;
		const append = (chunk: Buffer): void => {
			entry.tail = (entry.tail + chunk.toString("utf8")).slice(-TAIL_LIMIT);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("exit", (code, signal) => {
			// An intentional stop() clears entry.child first, and a respawn
			// replaces it — only a still-registered child exiting means a crash.
			const crashed = entry.child === child;
			if (crashed) entry.child = undefined;
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			if (crashed && entry.config.enabled && code !== 0) {
				entry.lastError = `adapter exited (${reason})${entry.tail.trim() ? `: ${entry.tail.trim().slice(-400)}` : ""}`;
			}
		});
		child.on("error", (error) => {
			entry.lastError = error.message;
		});
	}

	private stop(entry: RuntimeEntry): void {
		const child = entry.child;
		entry.child = undefined;
		if (child && child.exitCode === null && !child.killed) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}

	/** Create or update a config, persist, and (re)spawn when enabled. */
	save(input: Partial<ManagedChannelConfig>, id?: string): ManagedChannelInfo {
		const err = validate(input);
		if (err) throw new Error(err);
		const existing = id ? this.entries.get(id) : undefined;
		if (id && !existing) throw new Error(`Channel "${id}" not found`);
		const config: ManagedChannelConfig = {
			id: existing?.config.id ?? newId(),
			type: input.type as ManagedChannelType,
			name: input.name!.trim(),
			enabled: input.enabled ?? true,
			token: input.token,
			appId: input.appId,
			appSecret: input.appSecret,
			appToken: input.appToken,
			server: input.server,
			channel: input.channel,
			webhookUrl: input.webhookUrl,
			workspace: input.workspace!.trim(),
		};
		const entry: RuntimeEntry = existing ?? { config, tail: "" };
		entry.config = config;
		this.entries.set(config.id, entry);
		this.persist();
		if (config.enabled) this.spawn(entry);
		else this.stop(entry);
		return this.toInfo(entry);
	}

	delete(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Channel "${id}" not found`);
		this.stop(entry);
		this.entries.delete(id);
		this.persist();
	}

	setEnabled(id: string, enabled: boolean): ManagedChannelInfo {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Channel "${id}" not found`);
		entry.config = { ...entry.config, enabled };
		this.persist();
		if (enabled) this.spawn(entry);
		else this.stop(entry);
		return this.toInfo(entry);
	}

	/** Credential probe — the UI "Test" button. */
	async test(id: string): Promise<{ ok: boolean; message: string }> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Channel "${id}" not found`);
		const probe = await probeCredentials(entry.config, this.agentDir);
		if (!probe.ok) entry.lastError = probe.message;
		return probe;
	}
}
