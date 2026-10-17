import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { VERSION } from "../../config.js";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/config/resolve-config-value.js";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "../../core/mcp/index.js";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "../../core/mcp/oauth/index.js";
import type { McpServerEntry } from "./config.js";
import type { McpServerLog } from "./log.js";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.js";

export { McpServerLog } from "./log.js";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

export type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options?: McpRequestOptions): Promise<CallToolResult>;
}

export interface McpResourceServer {
	name: string;
	timeoutMs: number;
	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult>;
	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult>;
	allResources(options: McpRequestOptions): Promise<Resource[]>;
	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]>;
	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	hasResources = false;
	instructions: string | undefined;
	challenge: OAuthChallenge | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private readonly shutdown = new AbortController();
	private stderrTail: string | undefined;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	private readonly authProvider: McpAuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		providerToken?: (provider: string) => Promise<string | undefined>;
		onTools: (connection: McpServerConnection) => void;
		onChange?: (connection: McpServerConnection) => void;
		log?: McpServerLog;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		const url = this.oauthUrl;
		const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(this.entry.name, url),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: provider
				? { token: async () => options.providerToken?.(provider), settled: async () => {} }
				: undefined;
	}

	get name(): string {
		return this.entry.name;
	}

	private get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
			clientName: oauth.clientName,
			clientRegistration: oauth.clientRegistration,
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions = {}): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, { timeoutMs: this.timeoutMs, ...options }));
	}

	readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, { timeoutMs: this.timeoutMs, ...options }), true);
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions = {}): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, { timeoutMs: this.timeoutMs, ...options }), true);
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions = {}): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, { timeoutMs: this.timeoutMs, ...options }), {
					resourceTemplates: [],
				}),
			true,
		);
	}

	allResources(options: McpRequestOptions = {}): Promise<Resource[]> {
		return this.withClient((client) => client.listResources({ timeoutMs: this.timeoutMs, ...options }), true);
	}

	allResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
		return this.withClient((client) => listTemplates(client, { timeoutMs: this.timeoutMs, ...options }), true);
	}

	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.getClient();
			try {
				return await run(client);
			} catch (error) {
				if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
					await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
					continue;
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					if (this.client === client) this.client = undefined;
					continue;
				}
				if (!this.needsSignIn(error)) throw error;
				await this.dropClient(client);
				this.markNeedsAuth();
				throw new Error(signInRequiredMessage(this.entry));
			}
		}
	}

	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	private needsSignIn(error: unknown): boolean {
		return (
			error instanceof McpOAuthAuthorizationRequiredError ||
			(this.authProvider !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) this.client = undefined;
		await client.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		this.changed();
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		for (let attempt = 0; ; attempt++) {
			this.stderrTail = undefined;
			try {
				return await this.connectOnce();
			} catch (error) {
				const delay = retries[attempt];
				if (this.closed || delay === undefined || !isTransientError(error)) {
					throw this.connectFailed(error);
				}
				await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
				if (this.closed) throw this.connectFailed(error);
			}
		}
	}

	private async connectOnce(): Promise<McpClient> {
		const client = new McpClient({
			name: "pizza",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		const log = this.log;
		if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client.close().catch(() => undefined);
			return closing;
		};
		this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
			if (this.closed) throw new Error("shut down while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.hasResources = client.serverCapabilities?.resources !== undefined;
			this.instructions = client.instructions?.trim() || undefined;
			this.state = "connected";
			this.error = undefined;
			this.onTools(this);
			this.changed();
			return client;
		} catch (error) {
			await closeClient();
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			this.shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	private connectFailed(error: unknown): Error {
		if (this.needsSignIn(error) && !this.closed) {
			this.markNeedsAuth();
			return new Error(signInRequiredMessage(this.entry));
		}
		this.state = this.closed ? "closed" : "failed";
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		this.changed();
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		this.changed();
	}

	/** Refresh the server's tool list on demand (e.g. `_agentcli <server> --refresh`). */
	async refreshToolList(): Promise<McpTool[]> {
		const client = await this.getClient();
		const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
		if (this.client === client && !this.closed) {
			this.tools = tools;
			this.onTools(this);
			this.changed();
		}
		return tools;
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		this.changed();
	}

	async close(): Promise<void> {
		this.shutdown.abort();
		this.state = "closed";
		this.changed();
		const client = this.client;
		this.client = undefined;
		await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
		await this.authProvider?.settled();
	}
}