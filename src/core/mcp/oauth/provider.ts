import type { OAuthClientMetadataDocument, OAuthClientProvider } from "./flow.js";
import { McpOAuthAuthorizationRequiredError } from "./errors.js";
import type {
	AuthorizationServerMetadata,
	OAuthAuthorizationContext,
	OAuthCredentialBinding,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthTokens,
	OAuthTokenSaveContext,
} from "./types.js";

export interface McpOAuthState {
	serverUrl: string;
	/** A new interactive login supersedes previous login/refresh operations, including in other processes. */
	signInId?: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	/** When the access token expires, in milliseconds since the epoch, from `expires_in` at the time it was saved. */
	tokensExpireAt?: number;
	codeVerifier?: string;
	oauthState?: string;
	discovery?: OAuthDiscoveryState;
	credentialBinding?: OAuthCredentialBinding;
	authorizationContext?: OAuthAuthorizationContext;
}

export interface McpOAuthStateStore {
	load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
	save(state: McpOAuthState): void | Promise<void>;
	/** Implement atomically when a durable store is shared by multiple providers/processes. */
	update?(update: (state: McpOAuthState | undefined) => McpOAuthState | undefined): void | Promise<void>;
}

export interface McpOAuthProviderOptions {
	serverUrl: string | URL;
	redirectUrl: string | URL;
	clientMetadata: Omit<OAuthClientMetadata, "redirect_uris"> & { redirect_uris?: string[] };
	clientMetadataDocument?: (
		metadata: AuthorizationServerMetadata | undefined,
	) => OAuthClientMetadataDocument | undefined | Promise<OAuthClientMetadataDocument | undefined>;
	authorizationRedirectUrl?: (metadata: AuthorizationServerMetadata) => string;
	clientId?: string;
	clientSecret?: string;
	store?: McpOAuthStateStore;
	onRedirect(url: URL): void | Promise<void>;
}

export class MemoryOAuthStateStore implements McpOAuthStateStore {
	private value: McpOAuthState | undefined;

	load(): McpOAuthState | undefined {
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	save(state: McpOAuthState): void {
		this.value = structuredClone(state);
	}

	update(update: (state: McpOAuthState | undefined) => McpOAuthState | undefined): void {
		this.value = structuredClone(update(this.load()));
	}
}

/** Default stateful provider for one exact MCP server URL. Applications inject durable storage if needed. */
export class McpOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl: string;
	readonly clientMetadata: OAuthClientMetadata;
	readonly clientMetadataDocument?: (
		metadata: AuthorizationServerMetadata | undefined,
	) => OAuthClientMetadataDocument | undefined | Promise<OAuthClientMetadataDocument | undefined>;
	readonly authorizationRedirectUrl?: (metadata: AuthorizationServerMetadata) => string;
	private serverUrl: string;
	private configuredClient: OAuthClientInformationMixed | undefined;
	private store: McpOAuthStateStore;
	private onRedirect: (url: URL) => void | Promise<void>;
	private writes: Promise<void> = Promise.resolve();
	private pendingState: string | undefined;

	constructor(options: McpOAuthProviderOptions) {
		this.serverUrl = String(new URL(options.serverUrl));
		this.redirectUrl = String(options.redirectUrl);
		this.clientMetadata = {
			...options.clientMetadata,
			redirect_uris: options.clientMetadata.redirect_uris ?? [this.redirectUrl],
			grant_types: options.clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
			response_types: options.clientMetadata.response_types ?? ["code"],
			token_endpoint_auth_method:
				options.clientMetadata.token_endpoint_auth_method ?? (options.clientSecret ? "client_secret_post" : "none"),
		};
		this.clientMetadataDocument = options.clientMetadataDocument;
		this.authorizationRedirectUrl = options.authorizationRedirectUrl;
		this.configuredClient = options.clientId
			? { client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }
			: undefined;
		this.store = options.store ?? new MemoryOAuthStateStore();
		this.onRedirect = options.onRedirect;
	}

	async state(): Promise<string> {
		const state = this.pendingState ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		await this.update((value) => ({ ...value, oauthState: state }));
		return state;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return this.configuredClient ?? (await this.load()).clientInformation;
	}

	async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
		if (this.configuredClient) return;
		await this.update((value) => ({ ...value, clientInformation: information }));
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const state = await this.load();
		const clientId = this.configuredClient?.client_id ?? state.clientInformation?.client_id;
		return state.credentialBinding && state.credentialBinding.clientId === clientId ? state.tokens : undefined;
	}

	async saveTokens(tokens: OAuthTokens, context?: OAuthTokenSaveContext): Promise<void> {
		const expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
		await this.update((value) => {
			this.validateTokenContext(value, context);
			const next: McpOAuthState = { ...value, tokens };
			if (context?.kind === "device") next.credentialBinding = context.binding;
			// Background refresh must not erase a separate interactive authorization in progress.
			if (context?.kind !== "refresh_token") {
				delete next.codeVerifier;
				delete next.oauthState;
				delete next.authorizationContext;
			}
			if (expiresAt === undefined) delete next.tokensExpireAt;
			else next.tokensExpireAt = expiresAt;
			return next;
		});
		if (context?.kind !== "refresh_token") this.pendingState = undefined;
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		await this.onRedirect(url);
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		await this.update((value) => ({ ...value, codeVerifier: verifier }));
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.load()).codeVerifier;
		if (!verifier) throw new Error("No OAuth PKCE code verifier is stored");
		return verifier;
	}

	async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery", context?: OAuthTokenSaveContext): Promise<void> {
		await this.update((value) => {
			this.validateTokenContext(value, context);
			const next = { ...value };
			if (kind === "all" || kind === "client") {
				delete next.clientInformation;
				delete next.credentialBinding;
			}
			if (kind === "all" || kind === "tokens") {
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			if (kind === "all" || kind === "verifier") {
				delete next.codeVerifier;
				delete next.authorizationContext;
				delete next.oauthState;
			}
			if (kind === "all" || kind === "discovery") delete next.discovery;
			if (kind === "all") delete next.oauthState;
			return next;
		});
		if (kind === "all" || kind === "verifier") this.pendingState = undefined;
	}

	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
		await this.update((value) => ({ ...value, discovery }));
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.load()).discovery;
	}

	async credentialBinding(): Promise<OAuthCredentialBinding | undefined> {
		return (await this.load()).credentialBinding;
	}

	async saveCredentialBinding(credentialBinding: OAuthCredentialBinding): Promise<void> {
		await this.update((value) => ({ ...value, credentialBinding }));
	}

	async authorizationContext(): Promise<OAuthAuthorizationContext | undefined> {
		return (await this.load()).authorizationContext;
	}

	async saveAuthorizationContext(authorizationContext: OAuthAuthorizationContext): Promise<void> {
		await this.update((value) => ({ ...value, authorizationContext }));
	}

	private async load(): Promise<McpOAuthState> {
		await this.writes;
		return this.own(await this.store.load());
	}

	private async update(update: (state: McpOAuthState) => McpOAuthState): Promise<void> {
		this.writes = this.writes.catch(() => {}).then(async () => {
			if (this.store.update) await this.store.update((value) => update(this.own(value)));
			else await this.store.save(update(this.own(await this.store.load())));
		});
		await this.writes;
	}

	private validateTokenContext(state: McpOAuthState, context: OAuthTokenSaveContext | undefined): void {
		if (!context || context.kind === "device") return;
		const binding = context.kind === "authorization_code" ? context.authorization.binding : context.binding;
		const current = state.credentialBinding;
		if (!current || current.issuer !== binding.issuer || current.clientId !== binding.clientId || current.resource !== binding.resource) {
			throw new McpOAuthAuthorizationRequiredError();
		}
		if (context.kind === "authorization_code") {
			const pending = state.authorizationContext;
			if (pending?.state !== context.authorization.state || pending?.codeVerifier !== context.authorization.codeVerifier) {
				throw new McpOAuthAuthorizationRequiredError();
			}
		} else if (state.tokens?.refresh_token !== context.refreshToken) {
			throw new McpOAuthAuthorizationRequiredError();
		}
	}

	private own(state: McpOAuthState | undefined): McpOAuthState {
		return state?.serverUrl === this.serverUrl ? state : { serverUrl: this.serverUrl };
	}
}
