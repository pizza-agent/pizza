/**
 * Built-in MCP & `_agentcli` integration.
 *
 * Connects the servers from `mcp.json` and the servers extensions register with
 * `pizza.registerMcpServer()` when a session starts, and servers registered later right away. A
 * server in `mcp.json` takes precedence over a registered server of the same name.
 *
 * Instead of declaring MCP tools directly in the LLM request tool schema (which bloats the prompt
 * with hundreds of schemas), all configured MCP servers are exposed through the dynamic built-in
 * `_agentcli` underscore command. The agent discovers servers and tools progressively on demand:
 *
 *   _agentcli -h                              # list configured MCP servers
 *   _agentcli <server> -h                     # list tools offered by <server>
 *   _agentcli <server> <tool> -h              # generated CLI flag usage from JSON Schema
 *   _agentcli <server> <tool> --flag value    # call the tool
 *
 * `/mcp` opens an interactive manager to sign in (OAuth), reconnect, enable or disable servers,
 * and inspect their tools.
 */

import { join, resolve } from "node:path";
import type { SelectItem } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import { type McpExposure, type McpServerConfig, mcpNamespace } from "../../core/mcp/servers.js";
import type { ModelRegistry } from "../../core/models/model-registry.js";
import { openBrowser } from "../../utils/open-browser.js";
import { type AgentCliHost, createAgentCliBuiltinCommand } from "./agentcli.js";
import {
	addMcpServerConfig,
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpServerConfigPatch,
	type McpServerEntry,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "./config.js";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.js";
import { loadMcpRuntime } from "./runtime.lazy.js";
import type * as McpRuntime from "./runtime.js";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.js";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.js";

export const MCP_EXTENSION_ID = "mcp";

export type { McpTransportFactory } from "./runtime.js";
export {
	addMcpServerConfig,
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "./config.js";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Saves `/mcp` changes to the server's config file. */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/** How long to wait for servers when `_agentcli` is called. Default: 10000. */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	registeredConfig?: string;
	message?: string;
	attempt?: symbol;
	ready?: Promise<void>;
	closing?: Promise<void>;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "callable via _agentcli <server> <tool>",
	deferred: "callable via _agentcli <server> <tool>",
	direct: "callable via _agentcli <server> <tool>",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

function hasVisibleTools(entry: McpServerEntry): boolean {
	for (const exp of configuredExposures(entry)) {
		if (exp !== "hidden") return true;
	}
	return false;
}

export const MCP_SERVERS_SECTION = "mcp_servers";
const MAX_SERVER_DESCRIPTION_CHARS = 250;
export const MAX_SERVERS_SECTION_CHARS = 4096;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string; tools?: { name: string }[]; state?: string };
}

function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * Render the system prompt hint for `_agentcli` and configured MCP servers.
 * MCP tools are never declared directly in the LLM tool list; instead the model discovers and
 * invokes them through `_agentcli`.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => isEnabled(server) && hasVisibleTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;

	const header = [
		"## _agentcli (MCP servers)",
		"",
		"Configured MCP servers are loaded into the internal `_agentcli` command (their tools are NOT in the tool list schema — discover and call them via `_agentcli` through the `cli` tool):",
		"",
		"  _agentcli -h                              # list configured servers",
		"  _agentcli <server> -h                     # list a server's tools",
		"  _agentcli <server> <tool> -h              # inspect generated flags for a tool (run before first call)",
		"  _agentcli <server> <tool> --flag value    # call a tool (use --input '<json>' for complex objects)",
		"",
		"Configured servers:",
	].join("\n");

	const heads = listed.map((server) => `- ${server.entry.name}`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; run \`_agentcli -h\` to list all`] : [];
	const size = (kept: number) => [header, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [header, ...lines, ...omitted(listed.length - kept)].join("\n");
}

function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "starting";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, hasResources } = connection;
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${hasResources ? " · resources" : ""}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pizza: ExtensionAPI) => {
		let servers: McpServer[] = [];
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		let projectConfig: string | undefined;
		let overridden: string[] = [];
		let pending: Promise<unknown> | undefined;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		let modelRegistry: ModelRegistry | undefined;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));

		let session = new AbortController();
		session.abort();
		const backgroundActions = new Set<Promise<void>>();
		const track = <T>(work: Promise<T>): Promise<T> => {
			const task = work.then(
				() => undefined,
				() => undefined,
			);
			backgroundActions.add(task);
			void task.finally(() => backgroundActions.delete(task));
			return work;
		};
		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) =>
			servers.find((server) => server.entry.name === name || mcpNamespace(server.entry.name) === mcpNamespace(name));

		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pizza.getMcpServers()) {
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				if (configured) {
					overriddenNames.push(
						`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
					);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		const tokensAtSignIn = new Map<McpServerConnection, string>();
		const storedTokens = (connection: McpServerConnection): string => {
			const url = connection.oauthUrl;
			return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			emitChange();
		};
		const reconnectSignedIn = async () => {
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			if (signedIn.length === 0) return;
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
		};

		const createConnection = async (
			server: McpServer,
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			const runtime = await loadMcpRuntime();
			if (!isCurrent()) return undefined;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				providerToken: async (provider) => {
					const auth = await modelRegistry?.authStorage.getApiKey(provider);
					return auth;
				},
				log: getServerLog(runtime),
				onTools: () => {
					if (isCurrent()) emitChange();
				},
				onChange: (conn) => {
					if (isCurrent()) onConnectionChange(conn);
					else tokensAtSignIn.delete(conn);
				},
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			const { signal } = session;
			const attempt = Symbol();
			server.attempt = attempt;
			const isCurrent = () =>
				!signal.aborted && server.attempt === attempt && isEnabled(server) && servers.includes(server);
			const ready = (async () => {
				await after;
				if (!isCurrent()) return;
				const connection = await createConnection(server, isCurrent);
				if (!connection || !isCurrent()) return;
				await connection.getClient().catch(() => undefined);
			})();
			server.ready = ready.catch(() => undefined);
			return ready;
		};

		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			let timer: NodeJS.Timeout | undefined;
			const timeoutSignal = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, startupWaitMs);
			});
			try {
				for (;;) {
					const ready = waiting.flatMap((server) =>
						isEnabled(server) && servers.includes(server) && server.ready
							? [{ server, ready: server.ready }]
							: [],
					);
					if (ready.length === 0 || signal?.aborted) return;
					let onAbort: (() => void) | undefined;
					const finished = await Promise.race([
						Promise.all(ready.map((attempt) => attempt.ready)).then(() => true),
						timeoutSignal.then(() => false),
						new Promise<boolean>((resolve) => {
							onAbort = () => resolve(false);
							signal?.addEventListener("abort", onAbort, { once: true });
						}),
					]);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
					if (!finished || signal?.aborted) return;
					if (
						ready.every(
							(attempt) =>
								!isEnabled(attempt.server) ||
								!servers.includes(attempt.server) ||
								attempt.ready === attempt.server.ready,
						)
					) {
						return;
					}
				}
			} finally {
				clearTimeout(timer);
			}
		};

		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		const saveConfig = (server: McpServer, patch: McpServerConfigPatch, inProject = false): string | undefined => {
			const override = inProject ? projectConfig : server.entry.override;
			const entry = override ? { ...server.entry, override } : server.entry;
			if (entry.scope !== "extension") {
				try {
					updateConfig(entry, patch);
				} catch (error) {
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			return undefined;
		};

		const signIn = async (
			server: McpServer,
			prompt: McpSignInPrompt,
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				await track(
					runtime.signInMcpServer({
						serverUrl: url,
						store: getCredentials(runtime).forServer(server.entry.name, url),
						settings: connection.oauthSettings(),
						challenge: connection.challenge,
						prompt,
						signal,
					}),
				);
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = getCredentials(await loadMcpRuntime()).remove(server.entry.name, url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			const previous = server.ready;
			const ready = (async () => {
				await previous;
				await connection.reconnect();
			})();
			server.ready = ready.catch(() => undefined);
			try {
				await ready;
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		const setEnabled = async (
			server: McpServer,
			enabled: boolean,
			inProject = false,
		): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled }, inProject);
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.attempt = undefined;
				server.connection = undefined;
				if (connection) {
					server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
				}
				const closing = server.closing;
				emitChange();
				try {
					await closing;
				} finally {
					if (server.closing === closing) server.closing = undefined;
				}
				return undefined;
			}
			await startConnection(server, server.closing);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Register `_agentcli` dynamic built-in CLI command
		// ---------------------------------------------------------------------------------------

		// Other workspaces and external editors can change the shared config. Reconcile
		// on discovery without waiting for network connections or restarting healthy ones.
		const refreshConfig = (ctx: ExtensionContext) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			projectConfig = loaded.projectConfig;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			const desired = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			const previous = servers;
			const next = desired.map((candidate) => previous.find((server) =>
				JSON.stringify(server.entry) === JSON.stringify(candidate.entry),
			) ?? candidate);
			if (next.length === previous.length && next.every((server, index) => server === previous[index])) return;
			const closing = new Map<string, Promise<void>>();
			for (const server of previous) {
				if (next.includes(server)) continue;
				server.attempt = undefined;
				closing.set(server.entry.name, Promise.all([
					server.connection?.close(), server.ready, server.closing,
				]).then(() => undefined).catch(() => undefined));
			}
			servers = next;
			for (const server of servers) {
				if (!previous.includes(server) && isEnabled(server)) {
					void startConnection(server, closing.get(server.entry.name)).catch(() => undefined);
				}
			}
			emitChange();
		};

		const agentCliHost: AgentCliHost = {
			refreshConfig,
			getServers: () => servers,
			getConfigErrors: () => configErrors,
			async waitForServer(name: string, signal?: AbortSignal) {
				const server = findServer(name);
				if (!server) return undefined;
				if (isEnabled(server) && server.ready) {
					await waitForServers([server], signal);
				}
				return findServer(name);
			},
			async waitForAllServers(signal?: AbortSignal) {
				const waiting = servers.filter((s) => isEnabled(s) && s.ready);
				if (waiting.length > 0) await waitForServers(waiting, signal);
			},
			async addServer(name: string, config: McpServerConfig, opts: { local?: boolean; cwd: string }) {
				const path = opts.local
					? join(opts.cwd, CONFIG_DIR_NAME, "mcp.json")
					: join(getAgentDir(), "mcp.json");
				if (findServer(name)?.entry.scope === "extension") throw new Error(`MCP server "${name}" is managed by an extension`);
				const replaced = addMcpServerConfig(path, name, config);
				const existing = findServer(name);
				// Re-read the effective entry so project overrides retain precedence.
				const entry = loadMcpConfig({ agentDir: getAgentDir(), cwd: opts.cwd }).servers.find((item) => item.name === name);
				if (!entry) throw new Error(`Could not load MCP server "${name}" after saving`);
				if (existing) {
					const oldConn = existing.connection;
					existing.attempt = undefined;
					existing.connection = undefined;
					existing.entry = entry;
					configuredEntries = configuredEntries.map((item) => item.name === name ? entry : item);
					if (oldConn) {
						existing.closing = Promise.all([oldConn.close(), existing.ready]).then(() => undefined);
					}
					if (isEnabled(existing)) {
						await startConnection(existing, existing.closing);
					}
				} else {
					const server: McpServer = { entry };
					configuredEntries.push(entry);
					servers.push(server);
					if (isEnabled(server)) {
						await startConnection(server);
					}
				}
				emitChange();
				return { path, replaced };
			},
			async removeServer(name: string, opts: { local?: boolean; cwd: string }) {
				const path = opts.local
					? join(opts.cwd, CONFIG_DIR_NAME, "mcp.json")
					: join(getAgentDir(), "mcp.json");
				const removed = removeMcpServerConfig(path, name);
				if (removed) {
					const existing = findServer(name);
					if (existing) {
						servers = servers.filter((s) => s !== existing);
						configuredEntries = configuredEntries.filter((e) => e.name !== existing.entry.name);
						await existing.connection?.close();
						await existing.ready?.catch(() => undefined);
						const fallback = loadMcpConfig({ agentDir: getAgentDir(), cwd: opts.cwd }).servers.find((item) => item.name === name);
						if (fallback) {
							const restored: McpServer = { entry: fallback };
							servers.push(restored);
							configuredEntries.push(fallback);
							if (isEnabled(restored)) await startConnection(restored);
						}
						emitChange();
					}
				}
				return { path, removed };
			},
		};

		pizza.registerBuiltinCommand(createAgentCliBuiltinCommand(agentCliHost));

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or ${CONFIG_DIR_NAME}/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension"
					? "for this session"
					: entry.override
						? "saved to the project mcp.json"
						: entry.scope
							? `saved to the ${entry.scope} mcp.json`
							: "saved to mcp.json";
			const inProject = entry.scope === "global" && !entry.override && projectConfig !== undefined;
			const inProjectSaved = "saved to the project mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
				if (inProject) {
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (state === "connected" && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if (state === "connected" && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
				if (inProject) {
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				...(entry.override ? [`project override: ${entry.override}`] : []),
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const hasOverrides = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${hasOverrides ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.override ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const title = `Sign in to ${server.entry.name}`;
			const cancel = new AbortController();
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			let authorizationUrl = "";
			status("Contacting the authorization server…");
			return signIn(
				server,
				{
					showAuthorizationUrl: (url) => {
						authorizationUrl = url.href;
						openUrl(url.href);
					},
					promptForRedirectUrl: async (signal) => {
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						status("Connecting…");
						return value;
					},
				},
				cancel.signal,
			);
		};

		const runInBackground = (
			_ctx: ExtensionContext,
			server: McpServer,
			operation: () => Promise<string | undefined>,
		) => {
			const ready = operation();
			const attempt = server.attempt;
			const { signal } = session;
			const finish = (message: string | undefined) => {
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				server.message = message;
				emitChange();
			};
			void track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { signal } = session;
			let message: string | undefined;
			switch (action) {
				case "signin":
					message = await signInWithUi(ui, server);
					break;
				case "reconnect":
					runInBackground(ctx, server, async () => {
						await reconnect(server);
						return undefined;
					});
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
				case "enable-project":
				case "disable-project": {
					const enable = action.startsWith("enable");
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					break;
				}
			}
			if (signal.aborted) return;
			server.message = message;
			emitChange();
		};

		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or ${CONFIG_DIR_NAME}/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				const state = !isEnabled(server)
					? "disabled"
					: connection?.state === "disconnected"
						? "disconnected, reconnects on next call"
						: (connection?.state ?? "starting");
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			pickOpts: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!pickOpts.eligible(server)) ctx.ui.notify(pickOpts.none, "error");
				return server && pickOpts.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(pickOpts.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(pickOpts.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(pickOpts.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const { signal } = session;
			let failure: string | undefined;
			if (ctx.ui.surface === "tui") {
				await showMcpManager(ctx, async (ui) => {
					failure = await signInWithUi(ui, server);
				});
			} else {
				failure = await signIn(server, {
					showAuthorizationUrl: (url) => {
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						openUrl(url.href);
					},
					promptForRedirectUrl: (sig) =>
						ctx.ui.input(
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							"http://127.0.0.1:.../callback?code=...",
							{ signal: sig },
						),
				});
			}
			if (signal.aborted) return;
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		// ---------------------------------------------------------------------------------------
		// Lifecycle hooks
		// ---------------------------------------------------------------------------------------

		pizza.on("session_start", (_event, ctx) => {
			sessionCwd = ctx.cwd;
			modelRegistry = ctx.modelRegistry;

			if (!session.signal.aborted) {
				// session_start can fire more than once for the same session — the
				// facade emits it at creation (no UI bound yet) and interactive
				// mode emits it again once a UI context exists. Re-initializing
				// would drop live connections: reconcile the config instead, which
				// reuses server objects (and their connections) for unchanged
				// entries, starts newly-added servers, and closes removed ones.
				const { signal } = session;
				refreshConfig(ctx);
				const enabled = servers.filter(isEnabled);
				if (enabled.length === 0) {
					reportProblems(ctx);
					return;
				}
				pending = Promise.all(enabled.map((server) => server.ready))
					.then(() => {
						if (!signal.aborted) reportProblems(ctx);
					})
					.catch((error: unknown) => {
						try {
							ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
						} catch {}
					});
				return;
			}

			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			projectConfig = loaded.projectConfig;
			session = new AbortController();
			const { signal } = session;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			emitChange();
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			pending = Promise.all(enabled.map((server) => startConnection(server, runtime)))
				.then(() => {
					if (!signal.aborted) reportProblems(ctx);
				})
				.catch((error: unknown) => {
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		pizza.on("before_agent_start", (event) => {
			const section = renderServersSection(servers);
			if (!section) return;
			const sep = event.systemPrompt.endsWith("\n") ? "\n" : "\n\n";
			return { systemPrompt: event.systemPrompt + sep + section };
		});

		pizza.on("turn_start", async () => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn();
		});

		pizza.on("mcp_servers_change", async (_event, ctx) => {
			const { signal } = session;
			if (signal.aborted) return;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			emitChange();
			await Promise.all(removed.map((server) => server.connection?.close()));
			const connecting = added.filter(isEnabled);
			if (signal.aborted || connecting.length === 0) return;
			try {
				await Promise.all(connecting.map((server) => startConnection(server)));
				if (signal.aborted) {
					await Promise.all(connecting.map((server) => server.connection?.close()));
					return;
				}
			} catch (error) {
				ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				return;
			}
			if (signal.aborted) return;
			reportProblems(ctx, connecting);
		});

		pizza.on("session_shutdown", async () => {
			session.abort();
			const closing = connections();
			servers = [];
			emitChange();
			await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);
		});

		pizza.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.ui.surface === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else {
						await pending;
						ctx.ui.notify(formatStatus(), "info");
					}
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				await pending;
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: true });
}

export default createMcpExtension();
