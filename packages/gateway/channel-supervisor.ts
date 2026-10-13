/**
 * Channel supervisor — the gateway-side owner of message-channel integrations
 * (Discord / Lark / Slack / Telegram / webhook).
 *
 * The Channels tab in the desktop UI saves a config per integration; this
 * module persists those configs (`<agentDir>/channels.json`) and runs one
 * adapter per ENABLED channel inside the daemon. Delivery is a direct
 * in-process call into the agent pool via the channel host — no socket
 * round-trips, no extra processes, and live streaming replies.
 *
 *   UI ──channel_op──▶ gateway ──▶ supervisor ──▶ adapter ──deliver──▶ agent pool
 *
 * Fault containment: adapters must surface unrecoverable platform failures
 * through runtime.reportFatal() (marks the entry crashed → respawn budget).
 * An adapter that crashes the process uncatchably still takes the gateway
 * down — the accepted trade for in-process hosting, same as openclaw.
 */

import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import {
	channelAdapter,
	adapterPidPath,
	runChannel,
	type ChannelConfig,
	type ChannelBridge,
} from "../channels/index.js";
import { routeFetchThroughProxy } from "../channels/runtime.js";

export type ManagedChannelStatus = "connected" | "disconnected" | "error" | "configuring";

/** What `list` returns — config + live process state. */
export interface ManagedChannelInfo extends ChannelConfig {
	status: ManagedChannelStatus;
	lastError?: string;
	lastMessageAt?: number;
}

interface RuntimeEntry {
	config: ChannelConfig;
	/** Stops the running adapter (returned by runChannel). */
	stopAdapter?: () => Promise<void>;
	/** Adapter finished start() and is live. */
	running?: boolean;
	/** Set when the adapter failed to start or crashed. */
	lastError?: string;
	/** Crash-respawn bookkeeping. */
	restarts: number;
	startedAt: number;
	respawnTimer?: NodeJS.Timeout;
}

/** Give up respawning after this many rapid crashes; an adapter alive for
 *  longer than STABLE_MS resets the budget. */
const RESPAWN_MAX = 5;
const RESPAWN_DELAY_MS = 5000;
const STABLE_MS = 60_000;

function newId(): string {
	return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Persisted channel configs (`<agentDir>/channels.json`); [] when missing or unreadable. */
export function loadChannelConfigs(agentDir: string): ChannelConfig[] {
	try {
		const path = join(agentDir, "channels.json");
		if (!existsSync(path)) return [];
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return Array.isArray(parsed) ? (parsed as ChannelConfig[]) : [];
	} catch {
		return [];
	}
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

const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

/** Proxy vars an adapter should see: the resolved proxy mirrored into all
 *  common names. Empty when the proxy is unset or explicitly "off" — inline
 *  adapters share the daemon env, so there is nothing to inject (and no way
 *  to strip the daemon's own env). Exported for tests. */
export function adapterProxyEnv(agentDir: string): Record<string, string> {
	const proxy = systemProxy(agentDir);
	if (!proxy) return {};
	return {
		HTTPS_PROXY: proxy,
		https_proxy: proxy,
		HTTP_PROXY: proxy,
		http_proxy: proxy,
	};
}

/** Stable identity for the platform-side connection a channel binds to.
 *  Returns undefined when the type carries no comparable credential. */
function credentialKey(config: ChannelConfig): string | undefined {
	switch (config.type) {
		case "lark":
			return config.appId ? `lark:${config.appId}` : undefined;
		case "slack":
		case "discord":
		case "telegram":
			return config.token ? `${config.type}:${config.token}` : undefined;
		case "webhook":
			return config.webhookUrl ? `webhook:${config.webhookUrl}` : undefined;
		default:
			return undefined;
	}
}

/** Validate a save input. Returns an error string, or null when valid.
 *  Exported for tests. */
export function validate(input: Partial<ChannelConfig>): string | null {
	if (!input.name?.trim()) return "Display name is required";
	if (!input.workspace?.trim()) return "Select a workspace";
	const adapter = channelAdapter(String(input.type));
	return adapter ? adapter.validate(input) : `Unknown channel type "${String(input.type)}"`;
}

/** Real credential check — delegated to the adapter, through the same proxy
 *  the spawned adapter gets via env. */
async function probeCredentials(config: ChannelConfig, agentDir: string): Promise<{ ok: boolean; message: string }> {
	const adapter = channelAdapter(config.type);
	if (!adapter) return { ok: false, message: `Unknown channel type "${String(config.type)}"` };
	const proxy = systemProxy(agentDir);
	const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
	const proxiedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, dispatcher } as RequestInit);
	try {
		return await adapter.probe(config, proxiedFetch);
	} catch (error) {
		return { ok: false, message: `Connectivity check failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export interface ChannelSupervisorOptions {
	/** Lazily resolved in-process channel host (created by the gateway server
	 *  after this supervisor is constructed). */
	host: () => ChannelBridge;
	/** Test seam: replace the adapter registry. */
	adapterFor?: (type: string) => import("../channels/types.js").ChannelAdapter | undefined;
}

export class ChannelSupervisor {
	private readonly agentDir: string;
	private readonly configPath: string;
	private readonly entries = new Map<string, RuntimeEntry>();
	private settingsWatcher?: FSWatcher;
	private respawnTimer?: NodeJS.Timeout;
	private shuttingDown = false;
	private readonly options: ChannelSupervisorOptions;

	constructor(agentDir: string, options: ChannelSupervisorOptions) {
		this.agentDir = agentDir;
		this.configPath = join(agentDir, "channels.json");
		this.options = options;
	}

	/** Load persisted configs and start every enabled channel. Call at gateway start. */
	start(): void {
		for (const config of loadChannelConfigs(this.agentDir)) {
			this.entries.set(config.id, { config, restarts: 0, startedAt: 0 });
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
		this.shuttingDown = true;
		this.settingsWatcher?.close();
		clearTimeout(this.respawnTimer);
		for (const entry of this.entries.values()) {
			this.stop(entry);
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
		const alive = entry.running === true;
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
		entry.lastError = undefined;
		entry.startedAt = Date.now();
		// Stale pidfile from a dead gateway would make runChannel's slot claim
		// throw — clean it up first (liveAdapterPid removes dead pids itself,
		// so anything left here is ours or already invalid).
		try {
			unlinkSync(adapterPidPath(this.agentDir, entry.config.id));
		} catch {
			/* absent or held by someone else — claim decides */
		}
		// Export the resolved proxy into the daemon env so adapters'
		// proxyFromEnv() sees it. Only injects when set and absent —
		// "off"/unset leave the gateway env untouched.
		let injected = false;
		for (const [name, value] of Object.entries(adapterProxyEnv(this.agentDir))) {
			if (!process.env[name]) {
				process.env[name] = value;
				injected = true;
			}
		}
		// EnvHttpProxyAgent snapshots env at CONSTRUCTION — the global
		// dispatcher set at cli start never sees proxy vars injected here.
		// Re-create it so undici fetches (platform REST APIs) actually route
		// through the proxy. In-flight requests keep the old dispatcher.
		if (injected) setGlobalDispatcher(new EnvHttpProxyAgent());
		// Wrap fetch at adapter-start time too: bundled adapters may have their
		// module bodies run before their start() executes, so a wrap inside
		// the adapter can land too late (grammy's bot.init() hang). Bun's
		// fetch honors init.proxy deterministically, undici ignores it.
		{
			const proxy = systemProxy(this.agentDir);
			if (typeof proxy === "string") routeFetchThroughProxy(proxy);
		}
		entry.running = false;
		const onFatal = (error: unknown): void => {
			if (entry.stopAdapter === undefined) return; // already stopped/replaced
			entry.running = false;
			entry.stopAdapter = undefined;
			entry.lastError = `adapter failed: ${describeError(error)}`;
			this.scheduleRespawn(entry);
		};
		void runChannel(entry.config, this.agentDir, this.options.host(), onFatal, this.options.adapterFor?.(entry.config.type))
			.then((stopAdapter) => {
				if (this.shuttingDown || !entry.config.enabled) {
					void stopAdapter().catch(() => {});
					return;
				}
				entry.stopAdapter = stopAdapter;
				entry.running = true;
			})
			.catch((error: unknown) => {
				// Full cause chain + top stack frames — inline adapters' stderr
				// goes to the daemon log, so lastError is the UI-visible record.
				entry.lastError = `adapter failed to start: ${describeError(error)}`;
				this.scheduleRespawn(entry);
			});
	}

	/** Retry a crashed adapter — e.g. a platform SDK dropping its connection.
	 *  An adapter that stayed up for STABLE_MS gets a fresh budget; a rapid
	 *  crash loop gives up after RESPAWN_MAX attempts. */
	private scheduleRespawn(entry: RuntimeEntry): void {
		entry.restarts = Date.now() - entry.startedAt > STABLE_MS ? 1 : entry.restarts + 1;
		if (this.shuttingDown || entry.restarts > RESPAWN_MAX) return;
		entry.respawnTimer = setTimeout(() => {
			entry.respawnTimer = undefined;
			if (this.shuttingDown || !entry.config.enabled || entry.stopAdapter) return;
			this.spawn(entry);
		}, RESPAWN_DELAY_MS);
	}

	private stop(entry: RuntimeEntry): void {
		clearTimeout(entry.respawnTimer);
		entry.respawnTimer = undefined;
		const stopAdapter = entry.stopAdapter;
		entry.stopAdapter = undefined;
		entry.running = false;
		if (stopAdapter) void stopAdapter().catch(() => {});
	}

	/** Create or update a config, persist, and (re)spawn when enabled. */
	save(input: Partial<ChannelConfig>, id?: string): ManagedChannelInfo {
		const err = validate(input);
		if (err) throw new Error(err);
		const existing = id ? this.entries.get(id) : undefined;
		if (id && !existing) throw new Error(`Channel "${id}" not found`);
		const config: ChannelConfig = {
			id: existing?.config.id ?? newId(),
			type: input.type as ChannelConfig["type"],
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
		// Same-credential guard: platform websockets load-balance events
		// across every live connection, so two enabled channels bound to the
		// same bot/app would split deliveries between them. The pidfile only
		// dedupes by config.id — this catches duplicate credentials.
		if (config.enabled) {
			const conflict = this.findCredentialConflict(config);
			if (conflict) {
				throw new Error(`Same credentials as channel "${conflict.config.name}" — disable or delete it first`);
			}
		}
		const entry: RuntimeEntry = existing ?? { config, restarts: 0, startedAt: 0 };
		entry.config = config;
		this.entries.set(config.id, entry);
		this.persist();
		entry.restarts = 0;
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

	/** Another enabled channel bound to the same platform credentials, or
	 *  null. Identity per type: the credential that identifies the upstream
	 *  connection (bot token / appId / webhook listen address). */
	private findCredentialConflict(config: ChannelConfig): RuntimeEntry | undefined {
		const mine = credentialKey(config);
		if (!mine) return undefined;
		for (const entry of this.entries.values()) {
			if (entry.config.id === config.id || !entry.config.enabled) continue;
			if (credentialKey(entry.config) === mine) return entry;
		}
		return undefined;
	}

	setEnabled(id: string, enabled: boolean): ManagedChannelInfo {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Channel "${id}" not found`);
		if (enabled) {
			const conflict = this.findCredentialConflict({ ...entry.config, enabled });
			if (conflict) {
				throw new Error(`Same credentials as channel "${conflict.config.name}" — disable or delete it first`);
			}
		}
		entry.config = { ...entry.config, enabled };
		this.persist();
		entry.restarts = 0;
		if (enabled) this.spawn(entry);
		else this.stop(entry);
		return this.toInfo(entry);
	}

	/** Last recorded adapter error — debug aid for the UI. */
	tail(id: string): string {
		return this.entries.get(id)?.lastError ?? "";
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


function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** message + cause chain + a couple of stack frames — enough to localize a
 *  failure without digging through gateway.log. */
function describeError(error: unknown): string {
	let msg = errorMessage(error);
	let cause = (error as { cause?: unknown } | null)?.cause;
	let depth = 0;
	while (cause !== undefined && depth++ < 4) {
		msg += ` | cause: ${errorMessage(cause)}`;
		cause = (cause as { cause?: unknown } | null)?.cause;
	}
	const frames = error instanceof Error ? error.stack?.split("\n").slice(1, 4).map((l) => l.trim()) : undefined;
	if (frames?.length) msg += ` | at ${frames.join(" ← ")}`;
	return msg;
}
