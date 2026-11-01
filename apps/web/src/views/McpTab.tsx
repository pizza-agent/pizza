import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MCP_LOGIN_RPC_TIMEOUT_MS } from "@tomsun28/pizza-protocol";
import { Download, ExternalLink, Loader2, LogIn, LogOut, Pencil, Plus, Power, RotateCw, Search, Server, Trash2, Wrench } from "lucide-react";
import { Badge, Button, Card, ErrorBanner, Field, Modal, MoreMenu, Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import { sendCommandAwait, subscribeExtensionUi, openExternal } from "@/lib/transport";
import { confirmDialog } from "@/lib/confirm";
import i18n from "@/i18n";
import { McpToolParameters } from "@/components/McpToolParameters";
import { MCP_MARKETPLACE_CATALOG, type McpCatalogEntry } from "@/lib/mcp-catalog";
import { buildGoogleMcpConfig, googleMcpNeedsSetup, parseGoogleOAuthClient } from "@/lib/mcp-google-setup";
import { buildXMcpConfig, isLegacyXConnector, xMcpNeedsSetup } from "@/lib/mcp-x-setup";
import { needsSignIn, shouldAutoSignInAfterInstall, parseMcpDevicePrompt, canPasteMcpRedirect, type McpDevicePrompt } from "@/lib/mcp-signin";

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface McpServer {
	name: string;
	type: string;
	enabled: boolean;
	state: string;
	tools: number;
	scope?: string;
	config?: Record<string, unknown>;
	description?: string;
	url?: string;
	error?: string;
	oauth?: boolean;
}

function catalogDescription(entry: McpCatalogEntry): string {
	return i18n.t(`plugins.mcp.catalogDescriptions.${entry.name}`, { defaultValue: entry.description });
}

function serverDescription(server: McpServer): string | undefined {
	const entry = MCP_MARKETPLACE_CATALOG.find((entry) => entry.name === server.name);
	return entry && server.description === entry.config.description ? catalogDescription(entry) : server.description;
}
async function command(args: string[], timeoutMs = 60000) {
	const state = await sendCommandAwait<{
		capabilities?: { mcpManagement?: boolean };
	}>({ type: "get_state" }, 5000);
	if (!state.data?.capabilities?.mcpManagement)
		throw new Error(i18n.t("plugins.mcp.backendRestart"));
	const response = await sendCommandAwait<{ text: string }>(
		{ type: "mcp_command", args },
		timeoutMs,
	);
	const text = response.data?.text;
	if (!text) throw new Error("Empty MCP response");
	const result = JSON.parse(text);
	if (!result.ok) {
		const err = new Error(result.error?.message ?? text) as Error & {
			cancelled?: boolean;
			code?: string;
		};
		if (result.cancelled || result.error?.code === "CANCELLED") err.cancelled = true;
		err.code = result.error?.code;
		throw err;
	}
	return result;
}

function matchesQuery(text: string, query: string): boolean {
	if (!query.trim()) return true;
	return text.toLowerCase().includes(query.trim().toLowerCase());
}

function canSignOut(server: McpServer): boolean {
	return Boolean(server.oauth) && server.enabled && server.state === "connected";
}

function InstalledMcpCard({
	server,
	busy,
	loginActive,
	onSignIn,
	onSignOut,
	onViewTools,
	onEdit,
	onToggleEnabled,
	onRemove,
}: {
	server: McpServer;
	busy: boolean;
	loginActive: boolean;
	onSignIn: (name: string) => void;
	onSignOut: (server: McpServer) => void;
	onViewTools: (name: string) => void;
	onEdit: (server: McpServer) => void;
	onToggleEnabled: (server: McpServer) => void;
	onRemove: (server: McpServer) => void;
}) {
	const { t } = useTranslation();
	const extensionScoped = server.scope === "extension";
	const showSignIn =
		isLegacyXConnector(server.config ?? {}) ||
		needsSignIn(server) ||
		(Boolean(server.oauth) &&
			server.enabled &&
			server.state !== "connected" &&
			server.state !== "disabled");
	const menuItems = [
		...(showSignIn
			? [
					{
						icon: LogIn,
						label: t("plugins.mcp.signIn"),
						disabled: busy || loginActive,
						onClick: () => onSignIn(server.name),
					},
				]
			: []),
		...(canSignOut(server)
			? [
					{
						icon: LogOut,
						label: t("plugins.mcp.signOut"),
						disabled: busy || loginActive,
						onClick: () => onSignOut(server),
					},
				]
			: []),
		{
			icon: Power,
			label: server.enabled ? t("plugins.mcp.disable") : t("plugins.mcp.enable"),
			disabled: busy,
			onClick: () => onToggleEnabled(server),
		},
		{
			icon: Wrench,
			label: t("plugins.mcp.tools"),
			disabled: busy || !server.enabled,
			onClick: () => onViewTools(server.name),
		},
		...(!extensionScoped
			? [
					{
						icon: Pencil,
						label: t("plugins.mcp.edit"),
						disabled: busy,
						onClick: () => onEdit(server),
					},
					{ divider: true as const },
					{
						icon: Trash2,
						label: t("plugins.mcp.remove"),
						danger: true,
						disabled: busy,
						onClick: () => onRemove(server),
					},
				]
			: []),
	];
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className={cn("min-w-0 flex-1 transition-opacity", !server.enabled && "opacity-60")}>
					<div className="flex items-center gap-2">
						<Server className={cn("h-4 w-4 shrink-0", server.enabled ? "text-accent" : "text-muted")} />
						<span className="truncate text-sm font-medium text-fg">{server.name}</span>
					</div>
					{(serverDescription(server) || server.url) && (
						<p className="mt-2 line-clamp-2 text-xs text-muted">
							{serverDescription(server) || server.url}
						</p>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{server.enabled ? (
							<Badge tone="success">{t("plugins.mcp.enabled")}</Badge>
						) : (
							<Badge tone="neutral">{t("plugins.mcp.disabled")}</Badge>
						)}
						<Badge
							tone={
								server.state === "connected"
									? "success"
									: server.state === "needs-auth" || server.state === "failed"
										? "danger"
										: "neutral"
							}
						>
							{t(`plugins.mcp.states.${server.state}`, server.state)}
						</Badge>
						{extensionScoped && <Badge tone="neutral">{t("plugins.mcp.builtin")}</Badge>}
						<Badge tone="neutral">{server.config?.adapter === "gmail" ? t("plugins.mcp.localAdapter") : server.type}</Badge>
						<span className="text-[10px] text-muted">
							{t("plugins.mcp.toolCount", { count: server.tools })}
						</span>
					</div>
					{extensionScoped && !server.enabled && (
						<p className="mt-2 text-xs text-muted">{t("plugins.mcp.disableSessionHint")}</p>
					)}
					{server.error && (
						<p className="mt-2 break-words text-xs text-danger">{server.error}</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{needsSignIn(server) && (
						<Button
							size="sm"
							tone="accent"
							disabled={busy || loginActive}
							onClick={() => onSignIn(server.name)}
						>
							{t("plugins.mcp.signIn")}
						</Button>
					)}
					<MoreMenu disabled={busy} title={t("plugins.mcp.actions")} items={menuItems} />
				</div>
			</div>
		</Card>
	);
}

function DirectoryMcpCard({
	entry,
	installed,
	enabled,
	installing,
	onInstall,
}: {
	entry: McpCatalogEntry;
	installed: boolean;
	enabled?: boolean;
	installing: boolean;
	onInstall: () => void;
}) {
	const { t } = useTranslation();
	const items = [
		...(entry.docsUrl
			? [
					{
						icon: ExternalLink,
						label: t("plugins.mcp.view"),
						onClick: () => openExternal(entry.docsUrl!),
					},
				]
			: []),
		...(installed
			? []
			: [
					{
						icon: installing ? Loader2 : Download,
						label: installing ? t("plugins.mcp.installing") : t("plugins.mcp.install"),
						onClick: onInstall,
						disabled: installing,
					},
				]),
	];
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className={cn("min-w-0 flex-1 transition-opacity", installed && enabled === false && "opacity-60")}>
					<div className="flex items-center gap-2">
						<Server className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{entry.name}</span>
					</div>
					<p className="mt-2 line-clamp-2 text-xs text-muted">{catalogDescription(entry)}</p>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{installed ? (
							<>
								<Badge tone="success">{t("plugins.mcp.installed")}</Badge>
								{enabled === false ? (
									<Badge tone="neutral">{t("plugins.mcp.disabled")}</Badge>
								) : (
									<Badge tone="success">{t("plugins.mcp.enabled")}</Badge>
								)}
							</>
						) : installing ? (
							<Badge tone="accent">{t("plugins.mcp.installing")}</Badge>
						) : (
							<Badge tone="accent">{t("plugins.mcp.catalogType")}</Badge>
						)}
						{entry.builtin && (
							<Badge tone="neutral">{t("plugins.mcp.builtin")}</Badge>
						)}
						<Badge tone="neutral">{entry.config.adapter === "gmail" ? t("plugins.mcp.localAdapter") : entry.type}</Badge>
						{entry.oauthSetup && <Badge tone="neutral">{t(entry.oauthSetup === "x" ? "plugins.mcp.xSetupRequired" : "plugins.mcp.googleSetupRequired")}</Badge>}
					</div>
				</div>
				{items.length > 0 && (
					<div className="flex shrink-0 items-center gap-2">
						<MoreMenu title={t("plugins.mcp.actions")} items={items} />
					</div>
				)}
			</div>
		</Card>
	);
}

export function McpTab() {
	const { t } = useTranslation();
	const [servers, setServers] = useState<McpServer[]>([]);
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState(false);
	const [existing, setExisting] = useState(false);
	const [name, setName] = useState("");
	const [scope, setScope] = useState("global");
	const [transport, setTransport] = useState("http");
	const [endpoint, setEndpoint] = useState("");
	const [config, setConfig] = useState('{\n  "url": ""\n}');
	const [formError, setFormError] = useState("");
	const [saving, setSaving] = useState(false);
	const [details, setDetails] = useState<{
		name: string; tools: McpTool[]; loading: boolean; error: string;
	} | null>(null);
	const [toolQuery, setToolQuery] = useState("");
	const detailsRequest = useRef(0);
	const formRef = useRef<HTMLFormElement>(null);
	const [dialogAnchor, setDialogAnchor] = useState<HTMLElement | null>(null);
	const [login, setLogin] = useState<{
		name: string;
		authUrl: string;
		busy: boolean;
		error: string;
		device?: McpDevicePrompt;
	} | null>(null);
	const [loginAnswer, setLoginAnswer] = useState("");
	const [loginSubmitting, setLoginSubmitting] = useState(false);
	const loginActive = useRef(false);
	const loginRequest = useRef(0);
	useEffect(() => () => {
		loginRequest.current++;
		if (loginActive.current) void command(["server", "login-cancel"], 10000).catch(() => {});
		loginActive.current = false;
	}, []);
	const [installingName, setInstallingName] = useState<string | null>(null);
	const [installError, setInstallError] = useState("");
	const [oauthSetup, setOAuthSetup] = useState<{
		provider: "google" | "x";
		name: string; config: Record<string, unknown>; scope: string;
		clientId: string; clientSecret: string; callbackUrl: string; busy: boolean; error: string;
	} | null>(null);
	const attachRoot = useCallback((node: HTMLDivElement | null) => {
		setDialogAnchor(node?.closest<HTMLElement>("[data-settings-content]") ?? null);
	}, []);
	useEffect(() => () => { detailsRequest.current++; }, []);
	function closeDetails() {
		detailsRequest.current++;
		setDetails(null);
	}
	async function viewTools(serverName: string) {
		const request = ++detailsRequest.current;
		setToolQuery("");
		setDetails({ name: serverName, tools: [], loading: true, error: "" });
		try {
			const result = await command(["server", "tools", serverName, "--include-schema"]);
			if (request === detailsRequest.current)
				setDetails({ name: serverName, tools: result.data, loading: false, error: "" });
		} catch (e) {
			if (request === detailsRequest.current)
				setDetails({ name: serverName, tools: [], loading: false, error: e instanceof Error ? e.message : String(e) });
		}
	}
	const refresh = useCallback(async (): Promise<McpServer[]> => {
		setError("");
		try {
			const result = await command(["server", "list", "--include-config"]);
			const listed: McpServer[] = result.data ?? [];
			setServers(listed);
			setLoaded(true);
			setError((result.warnings ?? []).join("\n"));
			return listed;
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
			return [];
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function cancelLogin() {
		const request = ++loginRequest.current;
		loginActive.current = false;
		try {
			await command(["server", "login-cancel"], 10000);
		} catch {
			/* best-effort */
		}
		if (request === loginRequest.current) {
			setLogin(null);
			setLoginAnswer("");
			setLoginSubmitting(false);
		}
	}

	async function submitLoginAnswer() {
		const value = loginAnswer.trim();
		if (!value || !login || !canPasteMcpRedirect(login)) return;
		setLoginSubmitting(true);
		setLogin((prev) => (prev ? { ...prev, error: "" } : prev));
		try {
			await command(["server", "login-answer", value], 15000);
			setLoginAnswer("");
		} catch (e) {
			setLogin((prev) =>
				prev
					? { ...prev, error: e instanceof Error ? e.message : String(e), busy: true }
					: prev,
			);
			setLoginSubmitting(false);
		}
	}

	async function startSignIn(serverName: string, savedConfig?: Record<string, unknown>) {
		if (loginActive.current) return;
		const server = servers.find((server) => server.name === serverName);
		const signinConfig = savedConfig ?? server?.config;
		if (signinConfig && googleMcpNeedsSetup(signinConfig)) {
			openOAuthSetup(serverName, signinConfig, server?.scope ?? "global", "google");
			return;
		}
		if (signinConfig && xMcpNeedsSetup(signinConfig)) {
			openOAuthSetup(serverName, signinConfig, server?.scope ?? "global", "x");
			return;
		}
		const request = ++loginRequest.current;
		loginActive.current = true;
		setLoginAnswer("");
		setLoginSubmitting(false);
		setLogin({ name: serverName, authUrl: "", busy: true, error: "" });
		setError("");
		let unsub: (() => void) | undefined;
		try {
			unsub = await subscribeExtensionUi((req) => {
				if (request !== loginRequest.current) return;
				if (req.method !== "setStatus") return;
				const key = String(req.statusKey ?? "");
				if (key === `mcp-login-device:${serverName}` && typeof req.statusText === "string") {
					const device = parseMcpDevicePrompt(req.statusText);
					if (device) setLogin((prev) => prev?.name === serverName ? { ...prev, device } : prev);
					return;
				}
				if (key !== `mcp-login:${serverName}`) return;
				const url = typeof req.statusText === "string" ? req.statusText : "";
				if (url) setLogin((prev) => (prev?.name === serverName ? { ...prev, authUrl: url } : prev));
			});
			if (request !== loginRequest.current) return;
			await command(["server", "login", serverName], MCP_LOGIN_RPC_TIMEOUT_MS);
			if (request !== loginRequest.current) return;
			setLogin(null);
			await refresh();
		} catch (e) {
			if (request !== loginRequest.current) return;
			const cancelled =
				e instanceof Error && "cancelled" in e && (e as Error & { cancelled?: boolean }).cancelled;
			if (cancelled) {
				setLogin(null);
				return;
			}
			const message = e instanceof Error ? e.message : String(e);
			const listed = await refresh();
			if (request !== loginRequest.current) return;
			// Older gateways may time out while the agent completes OAuth in the background.
			if (/timeout|timed?\s*out/i.test(message) && listed.some((server) => server.name === serverName && server.state === "connected")) {
				setLogin(null);
				setError("");
				return;
			}
			setLogin((prev) =>
				prev ? { ...prev, busy: false, error: message } : prev,
			);
			setError(message);
		} finally {
			unsub?.();
			if (request === loginRequest.current) {
				loginActive.current = false;
				setLoginSubmitting(false);
			}
		}
	}

	useEffect(() => {
		if (
			!servers.some((server) =>
				["starting", "connecting"].includes(server.state),
			)
		)
			return;
		const timer = setTimeout(() => {
			void refresh();
		}, 1000);
		return () => clearTimeout(timer);
	}, [servers, refresh]);
	async function act(run: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await run();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	async function installCatalogEntry(entry: McpCatalogEntry) {
		if (servers.some((s) => s.name === entry.name)) return;
		if (entry.oauthSetup) {
			openOAuthSetup(entry.name, entry.config, "global", entry.oauthSetup);
			return;
		}
		setInstallingName(entry.name);
		setInstallError("");
		let autoSignInName: string | null = null;
		try {
			await command([
				"server",
				"add",
				entry.name,
				"--config",
				JSON.stringify(entry.config),
			]);
			const listed = await refresh();
			const installed = listed.find((s) => s.name === entry.name);
			// Marketplace OAuth connectors: open Sign in without a second click.
			// Login failures must not roll back the install (server stays listed).
			if (installed && shouldAutoSignInAfterInstall(installed)) {
				autoSignInName = entry.name;
			}
		} catch (e) {
			setInstallError(e instanceof Error ? e.message : String(e));
		} finally {
			setInstallingName(null);
		}
		if (autoSignInName) void startSignIn(autoSignInName);
	}
	function openOAuthSetup(serverName: string, config: Record<string, unknown>, scope: string, provider: "google" | "x") {
		const oauth = config.oauth as Record<string, unknown> | undefined;
		const entry = MCP_MARKETPLACE_CATALOG.find((entry) => entry.name === (provider === "x" ? "x" : "gmail"))!;
		const defaults = entry.config.oauth as Record<string, unknown>;
		setOAuthSetup({ name: serverName, config, scope, provider,
			clientId: typeof oauth?.clientId === "string" ? oauth.clientId : "",
			clientSecret: typeof oauth?.clientSecret === "string" ? oauth.clientSecret : "",
			callbackUrl: typeof oauth?.callbackUrl === "string" ? oauth.callbackUrl : String(defaults.callbackUrl), busy: false, error: "" });
	}
	async function saveOAuthSetup() {
		if (!oauthSetup || oauthSetup.busy) return;
		const setup = oauthSetup;
		setOAuthSetup((prev) => prev ? { ...prev, busy: true, error: "" } : prev);
		try {
			const configured = setup.provider === "x" ? buildXMcpConfig(setup.config, setup) : buildGoogleMcpConfig(setup.config, setup);
			await command(["server", "add", setup.name, ...(setup.scope === "project" ? ["--local"] : []), "--config", JSON.stringify(configured)]);
			await refresh();
			setOAuthSetup(null);
			// Use the config just saved; React's server list may still be from before setup.
			void startSignIn(setup.name, configured);
		} catch (error) {
			setOAuthSetup((prev) => prev ? { ...prev, busy: false, error: error instanceof Error ? error.message : String(error) } : prev);
		}
	}
	const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
	const installedByName = useMemo(() => new Map(servers.map((s) => [s.name, s])), [servers]);
	const filteredInstalled = useMemo(
		() =>
			servers.filter((s) =>
				matchesQuery(`${s.name} ${serverDescription(s) ?? ""} ${s.url ?? ""}`, query),
			),
		[servers, query],
	);
	const filteredCatalog = useMemo(
		() =>
			MCP_MARKETPLACE_CATALOG.filter((entry) =>
				matchesQuery(`${entry.name} ${catalogDescription(entry)}`, query),
			),
		[query],
	);
	function edit(server?: McpServer) {
		setExisting(!!server);
		setName(server?.name ?? "");
		setScope(server?.scope ?? "global");
		setTransport(!server || server.config?.url ? "http" : "stdio");
		setEndpoint(
			typeof server?.config?.url === "string" ? server.config.url : "",
		);
		setConfig(JSON.stringify(server?.config ?? { url: "" }, null, 2));
		setEditing(true);
		closeDetails();
		setFormError("");
	}
	async function save() {
		setSaving(true);
		setFormError("");
		try {
			const parsed = JSON.parse(config);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error(t("plugins.mcp.invalidConfig"));
			if (transport === "http") {
				const url = new URL(endpoint);
				if (!["http:", "https:"].includes(url.protocol))
					throw new Error(t("plugins.mcp.invalidUrl"));
				parsed.url = endpoint;
			}
			if (!name.trim() || name.trim().startsWith("-"))
				throw new Error(t("plugins.mcp.invalidName"));

			if (!existing && servers.some((server) => server.name === name.trim()))
				throw new Error(t("plugins.mcp.duplicateName"));

			await command([
				"server",
				"add",
				name.trim(),
				...(scope === "project" ? ["--local"] : []),
				"--config",
				JSON.stringify(parsed),
			]);
			setEditing(false);
			await refresh();
		} catch (e) {
			setFormError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div ref={attachRoot} className="space-y-4">
			<p className="text-sm text-muted">{t("plugins.mcp.description")}</p>
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative grow">
					<Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
					<input
						aria-label={t("plugins.mcp.search")}
						placeholder={t("plugins.mcp.search")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm"
					/>
				</div>
				<Button
					size="sm"
					disabled={busy}
					onClick={() => void act(async () => {})}
					iconLeft={<RotateCw className="h-3.5 w-3.5" />}
				>
					{t("plugins.mcp.refresh")}
				</Button>
				<Button
					size="sm"
					tone="accent"
					disabled={busy}
					onClick={() => edit()}
					iconLeft={<Plus className="h-3.5 w-3.5" />}
				>
					{t("plugins.mcp.add")}
				</Button>
			</div>
			{error && (
				<div
					role="alert"
					className="rounded-lg border border-danger/30 p-3 text-sm text-danger"
				>
					{error}
				</div>
			)}
			{editing && (
				<Modal
					open={editing}
					onClose={() => { if (!saving) setEditing(false); }}
					title={t(existing ? "plugins.mcp.edit" : "plugins.mcp.add")}
					size="lg"
					backdrop={false}
					anchor={dialogAnchor}
					footer={<div className="flex w-full items-center justify-between gap-2">
						<Button type="button" tone="neutral" variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)}>{t("plugins.mcp.cancel")}</Button>
						<Button type="button" size="sm" loading={saving} onClick={() => formRef.current?.requestSubmit()} tone="accent" disabled={saving}>
							{t(saving ? "plugins.mcp.saving" : "plugins.mcp.save")}
						</Button>
					</div>}
				>
					<form
						ref={formRef}
						className="max-h-[calc(85dvh-10rem)] space-y-4 overflow-y-auto pr-1"
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<p className="text-sm text-muted">{t("plugins.mcp.formHint")}</p>
						{formError && <ErrorBanner message={formError} />}
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
							<div>
								<span className="label">{t("plugins.mcp.transport")}</span>
								<fieldset disabled={saving} className="min-w-0 disabled:opacity-50">
									<Select
										value={transport}
										title={t("plugins.mcp.transport")}
										options={[
											{ value: "http", label: t("plugins.mcp.httpShort"), hint: "Streamable HTTP" },
											{ value: "stdio", label: t("plugins.mcp.stdioShort"), hint: "stdio" },
										]}
										onChange={(value) => {
											setTransport(value);
											setEndpoint("");
											setConfig(JSON.stringify(value === "http" ? { url: "" } : { command: "npx", args: [] }, null, 2));
										}}
									/>
								</fieldset>
							</div>
							<Field label={t("plugins.mcp.name")}>
								<input required autoFocus={!existing} disabled={existing || saving}
									value={name} onChange={(e) => setName(e.target.value)}
									className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50" />
							</Field>
						</div>
						{transport === "http" && (
							<Field label={t("plugins.mcp.url")} hint={t("plugins.mcp.httpHint")}>
								<input
									autoFocus={existing}
									type="url"
									required
									disabled={saving}
									value={endpoint}
									placeholder="https://mcp.example.com/mcp"
									onChange={(e) => {
										setEndpoint(e.target.value);
										try {
											const parsed = JSON.parse(config);
											if (
												parsed &&
												typeof parsed === "object" &&
												!Array.isArray(parsed)
											)
												setConfig(
													JSON.stringify(
														{ ...parsed, url: e.target.value },
														null,
														2,
													),
												);
										} catch {
											/* Preserve incomplete advanced configuration. */
										}
									}}
									className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
								/>
							</Field>
						)}

						<details key={transport} open={transport === "stdio"} className="rounded-lg border border-border p-3">
							<summary className="cursor-pointer text-sm font-medium">{t("plugins.mcp.advanced")}</summary>
						<div className="mt-3"><Field label={t("plugins.mcp.config")}>
							<textarea
								required
								disabled={saving}
								spellCheck={false}
								rows={7}
								value={config}
								onChange={(e) => {
									setConfig(e.target.value);
									try {
										const value = JSON.parse(e.target.value);
										if (typeof value.url === "string") {
											setEndpoint(value.url);
											setTransport("http");
										} else if (typeof value.command === "string")
											setTransport("stdio");
									} catch {
										/* Keep incomplete JSON editable; save reports validation errors. */
									}
								}}
								className="block w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs text-fg focus:border-accent focus:outline-none"
							/>
						</Field></div>
						<p className="mt-2 text-xs text-muted">{t("plugins.mcp.configHint")}</p>
						</details>
					</form>
				</Modal>
			)}
			{installError && (
				<div role="alert" className="rounded-lg border border-danger/30 p-3 text-sm text-danger">
					{t("plugins.mcp.installError", { error: installError })}
				</div>
			)}
			{loading ? (
				<p className="text-sm text-muted">{t("plugins.mcp.loading")}</p>
			) : (
				<>
					{loaded && (
						<>
							<h2 className="mb-3 text-sm font-semibold text-fg">
								{t("plugins.mcp.installedSection")} ({filteredInstalled.length})
							</h2>
							{filteredInstalled.length === 0 ? (
								<Card className="mb-6">
									<div className="py-6 text-center">
										<Server className="mx-auto mb-2 h-8 w-8 text-muted/40" />
										<p>{t("plugins.mcp.empty")}</p>
										<p className="mt-2 text-sm text-muted">
											{t("plugins.mcp.emptyHint")}
										</p>
									</div>
								</Card>
							) : (
								<div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
									{filteredInstalled.map((server) => (
										<InstalledMcpCard
											key={server.name}
											server={server}
											busy={busy}
											loginActive={!!login}
											onSignIn={(name) => void startSignIn(name)}
											onSignOut={(s) =>
												void act(async () => {
													await command(["server", "logout", s.name]);
												})
											}
											onViewTools={(name) => void viewTools(name)}
											onEdit={edit}
											onToggleEnabled={(s) =>
												void act(async () => {
													await command([
														"server",
														s.enabled ? "disable" : "enable",
														s.name,
													]);
												})
											}
											onRemove={(s) =>
												void (async () => {
													if (s.scope === "extension") return;
													if (
														await confirmDialog({
															title: t("plugins.mcp.remove"),
															message: t("plugins.mcp.removeConfirm", {
																name: s.name,
															}),
														})
													)
														await act(() =>
															command([
																"server",
																"remove",
																s.name,
																...(s.scope === "project" ? ["--local"] : []),
															]),
														);
												})()
											}
										/>
									))}
								</div>
							)}
						</>
					)}

					<h2 className="mb-3 text-sm font-semibold text-fg">
						{t("plugins.mcp.directorySection")} ({filteredCatalog.length})
					</h2>
					{filteredCatalog.length === 0 ? (
						<Card>
							<div className="py-6 text-center">
								<Server className="mx-auto mb-2 h-8 w-8 text-muted/40" />
								<p className="font-mono text-xs text-muted">{t("plugins.mcp.emptyDirectory")}</p>
							</div>
						</Card>
					) : (
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{filteredCatalog.map((entry) => (
								<DirectoryMcpCard
									key={entry.name}
									entry={entry}
									installed={installedNames.has(entry.name)}
									enabled={installedByName.get(entry.name)?.enabled}
									installing={installingName === entry.name}
									onInstall={() => void installCatalogEntry(entry)}
								/>
							))}
						</div>
					)}
				</>
			)}
			{oauthSetup && (
				<Modal open title={t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupTitle" : "plugins.mcp.googleSetupTitle")} onClose={() => { if (!oauthSetup.busy) setOAuthSetup(null); }} size="md" backdrop={false} anchor={dialogAnchor}
					footer={<><Button tone="neutral" variant="ghost" disabled={oauthSetup.busy} onClick={() => setOAuthSetup(null)}>{t("plugins.mcp.cancel")}</Button><Button loading={oauthSetup.busy} disabled={!oauthSetup.clientId.trim() || (oauthSetup.provider === "google" && !oauthSetup.clientSecret.trim())} onClick={() => void saveOAuthSetup()}>{t("plugins.mcp.googleSetupConnect")}</Button></>}>
					<div className="space-y-4">
						<p className="text-sm text-muted">{t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupIntro" : "plugins.mcp.googleSetupIntro")}</p>
						<ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
							<li>{t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupApp" : "plugins.mcp.googleSetupApis")}</li>
								<li>{t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupClient" : "plugins.mcp.googleSetupClient")}</li>
								<li>{t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupAccess" : "plugins.mcp.googleSetupTestUsers")}</li>
							</ol>
						<a className="text-sm text-link underline" href={MCP_MARKETPLACE_CATALOG.find((entry) => entry.name === (oauthSetup.provider === "x" ? "x" : "gmail"))!.docsUrl} target="_blank" rel="noreferrer">{t(oauthSetup.provider === "x" ? "plugins.mcp.xSetupDocs" : "plugins.mcp.googleSetupDocs")}</a>
						{oauthSetup.provider === "google" && <Field label={t("plugins.mcp.googleClientImport")}>
							<input type="file" accept=".json,application/json" disabled={oauthSetup.busy} className="w-full text-xs" onChange={async (event) => {
								const file = event.target.files?.[0]; if (!file) return;
								try {
									const client = parseGoogleOAuthClient(await file.text());
									setOAuthSetup((prev) => prev ? { ...prev, clientId: client.clientId, clientSecret: client.clientSecret, callbackUrl: client.callbackUrl ?? prev.callbackUrl, error: "" } : prev);
								} catch (error) { setOAuthSetup((prev) => prev ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev); }
							}} />
						</Field>}
						<Field label="Client ID"><input value={oauthSetup.clientId} disabled={oauthSetup.busy} autoComplete="off" onChange={(event) => setOAuthSetup((prev) => prev ? { ...prev, clientId: event.target.value } : prev)} className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-xs" /></Field>
						<Field label={oauthSetup.provider === "x" ? t("plugins.mcp.xClientSecret") : "Client secret"}><input type="password" value={oauthSetup.clientSecret} disabled={oauthSetup.busy} autoComplete="new-password" onChange={(event) => setOAuthSetup((prev) => prev ? { ...prev, clientSecret: event.target.value } : prev)} className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-xs" /></Field>
						<Field label={t("plugins.mcp.googleCallbackUrl")}><input value={oauthSetup.callbackUrl} disabled={oauthSetup.busy} onChange={(event) => setOAuthSetup((prev) => prev ? { ...prev, callbackUrl: event.target.value } : prev)} className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-xs" /><p className="mt-1 text-xs text-muted">{t(oauthSetup.provider === "x" ? "plugins.mcp.xCallbackHint" : "plugins.mcp.googleCallbackHint")}</p></Field>
						{oauthSetup.error && <ErrorBanner message={oauthSetup.error} />}
					</div>
				</Modal>
			)}
			{login && (
				<Modal
					open
					title={t("plugins.mcp.signInTitle", { name: login.name })}
					onClose={() => { void cancelLogin(); }}
					size="md"
					backdrop={false}
					anchor={dialogAnchor}
					footer={
						<div className="flex w-full items-center justify-end gap-2">
							<Button
								type="button"
								tone="neutral"
								variant="ghost"
								size="sm"
								onClick={() => void cancelLogin()}
							>
								{t("plugins.mcp.cancel")}
							</Button>
						</div>
					}
				>
					<div className="space-y-3">
						{login.device && login.busy && !login.error && (
							<div className="space-y-2 rounded-lg border border-border bg-surface p-4">
								<p className="text-sm text-muted">{t("plugins.mcp.deviceCodeHint")}</p>
								<p className="select-all font-mono text-2xl tracking-widest" aria-label={t("plugins.mcp.deviceCode")}>{login.device.userCode}</p>
								<p className="text-xs text-muted">{t("plugins.mcp.deviceCodeExpires", { time: new Date(login.device.expiresAt).toLocaleTimeString() })}</p>
							</div>
						)}
						{!login.error && (login.authUrl ? (
							<div className="space-y-1">
								<a
									href={login.authUrl}
									target="_blank"
									rel="noreferrer"
									className="break-all text-xs text-link underline"
								>
									{login.authUrl}
								</a>
								<p className="text-xs text-muted">{t(login.device ? "plugins.mcp.deviceCodeWaiting" : "plugins.mcp.signInWaiting")}</p>
							</div>
						) : (
							<p className="text-xs text-muted">
								{login.busy ? t("plugins.mcp.signInStarting") : t("plugins.mcp.signInWaiting")}
							</p>
						))}
						{login.error && <ErrorBanner message={login.error} />}
						{canPasteMcpRedirect(login) && <details className="text-xs text-muted">
							<summary className="cursor-pointer">{t("plugins.mcp.signInPasteOptional")}</summary>
							<p className="my-2">{t("plugins.mcp.signInRedirectHint")}</p>
							<Field label={t("plugins.mcp.signInPaste")}>
							<div className="flex items-center gap-2">
								<input
									value={loginAnswer}
									disabled={loginSubmitting}
									placeholder={t("plugins.mcp.signInPastePlaceholder")}
									onChange={(e) => setLoginAnswer(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void submitLoginAnswer();
									}}
									className="h-9 min-w-0 grow rounded-lg border border-border bg-surface px-3 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
								/>
								<Button
									size="sm"
									tone="accent"
									disabled={!loginAnswer.trim() || loginSubmitting}
									loading={loginSubmitting}
									onClick={() => void submitLoginAnswer()}
								>
									{t("plugins.mcp.signInContinue")}
								</Button>
							</div>
						</Field></details>}
						{!login.busy && login.error && <Button size="sm" onClick={() => void startSignIn(login.name)}>{t("plugins.mcp.retry")}</Button>}
					</div>
				</Modal>
			)}
			{details && (
				<Modal open title={`${details.name} · ${t("plugins.mcp.tools")}`} onClose={closeDetails} size="lg"
					backdrop={false}
					anchor={dialogAnchor}
					footer={<Button tone="neutral" variant="ghost" size="sm" onClick={closeDetails}>{t("plugins.mcp.close")}</Button>}>
					<div className="max-h-[calc(85dvh-10rem)] space-y-4 overflow-y-auto pr-1">
						{details.loading ? <p role="status" className="py-8 text-center text-sm text-muted">{t("plugins.mcp.loadingTools")}</p>
						: details.error ? <div className="space-y-3">
							<p role="alert" className="text-sm text-danger">{details.error}</p>
							<Button size="sm" onClick={() => void viewTools(details.name)}>{t("plugins.mcp.retry")}</Button>
						</div> : <>
							<div className="flex items-center justify-between gap-3">
								<input autoFocus aria-label={t("plugins.mcp.searchTools")} placeholder={t("plugins.mcp.searchTools")}
									value={toolQuery} onChange={(e) => setToolQuery(e.target.value)}
									className="h-9 min-w-0 grow rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none" />
								<span className="shrink-0 text-xs text-muted">{t("plugins.mcp.toolCount", { count: details.tools.length })}</span>
							</div>
							<ul className="divide-y divide-border">
								{details.tools.filter((tool) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(toolQuery.toLowerCase())).map((tool) => (
									<li key={tool.name} className="space-y-2 py-4 first:pt-0">
										<h4 className="break-all font-mono text-sm font-medium text-fg">{tool.name}</h4>
										{tool.description && <p className="whitespace-pre-wrap break-words text-sm text-muted">{tool.description}</p>}
										<McpToolParameters schema={tool.inputSchema} />
									</li>
								))}
							</ul>
							{!details.tools.some((tool) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(toolQuery.toLowerCase())) &&
								<p className="py-6 text-center text-sm text-muted">{t(details.tools.length ? "plugins.mcp.noMatchingTools" : "plugins.mcp.noTools")}</p>}
						</>}
					</div>
				</Modal>
			)}
		</div>
	);
}
