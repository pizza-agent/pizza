/**
 * Channel supervisor — the gateway-side owner of message-channel integrations
 * (Discord / Lark / Slack / Telegram / webhook).
 *
 * The Channels tab in the desktop UI saves a config per integration; this
 * module persists those configs (`<agentDir>/channels.json`), spawns one
 * adapter process per ENABLED channel (`pizza channel run <id>` — the same
 * CLI/binary the gateway runs from), and reports live status back so the UI
 * badge means something real:
 *
 *   UI ──channel_op──▶ gateway ──▶ supervisor ──spawn──▶ adapter process ──tell──▶ gateway (again)
 *
 * Adapters run out of process on purpose: some patch `https.request` for proxy
 * support, and a crashing platform SDK must not take the gateway down. The
 * platform-specific parts (validation, credential probe, the relay itself)
 * live in packages/channels/<type>.ts.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { ProxyAgent } from "undici";
import { channelAdapter, type ChannelConfig } from "../channels/index.js";
import { resolveCliSpawn } from "../rpc/cli-spawn.js";

export type ManagedChannelStatus = "connected" | "disconnected" | "error" | "configuring";

/** What `list` returns — config + live process state. */
export interface ManagedChannelInfo extends ChannelConfig {
	status: ManagedChannelStatus;
	lastError?: string;
	lastMessageAt?: number;
}

interface RuntimeEntry {
	config: ChannelConfig;
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

/** Proxy env var names — stripped from the child env when the user turns the
 *  proxy off, so a proxied shell that launched the gateway can't leak through. */
const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

/** Env for an adapter process: the gateway's env plus the resolved proxy
 *  (adapters read HTTPS_PROXY). Exported for tests. */
export function childEnv(agentDir: string): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	const proxy = systemProxy(agentDir);
	if (proxy === false) {
		for (const name of PROXY_ENV_VARS) delete env[name];
	} else if (proxy) {
		env.HTTPS_PROXY ??= proxy;
		env.https_proxy ??= proxy;
		env.HTTP_PROXY ??= proxy;
		env.http_proxy ??= proxy;
	}
	return env;
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
		for (const config of loadChannelConfigs(this.agentDir)) {
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
		entry.lastError = undefined;
		entry.tail = "";
		// Re-run the CLI we're running from: `node cli.js …` or the compiled binary.
		const { cliPath, binary } = resolveCliSpawn();
		const args = ["channel", "run", entry.config.id, "--agent-dir", this.agentDir];
		let child: ChildProcess;
		try {
			child = spawn(binary ? cliPath : process.execPath, binary ? args : [cliPath, ...args], {
				env: childEnv(this.agentDir),
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
