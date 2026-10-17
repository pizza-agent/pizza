import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RotateCw, Server, Search } from "lucide-react";
import { Badge, Button, Card, ErrorBanner, Field, Modal, Select } from "@/components/ui";
import { sendCommandAwait } from "@/lib/transport";
import { confirmDialog } from "@/lib/confirm";
import i18n from "@/i18n";
import { McpToolParameters } from "@/components/McpToolParameters";

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
}
async function command(args: string[]) {
	const state = await sendCommandAwait<{
		capabilities?: { mcpManagement?: boolean };
	}>({ type: "get_state" }, 5000);
	if (!state.data?.capabilities?.mcpManagement)
		throw new Error(i18n.t("plugins.mcp.backendRestart"));
	const response = await sendCommandAwait<{ text: string }>(
		{ type: "mcp_command", args },
		60000,
	);
	const text = response.data?.text;
	if (!text) throw new Error("Empty MCP response");
	const result = JSON.parse(text);
	if (!result.ok) throw new Error(result.error?.message ?? text);
	return result;
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
	const refresh = useCallback(async () => {
		setError("");
		try {
			const result = await command(["server", "list", "--include-config"]);
			setServers(result.data);
			setLoaded(true);
			setError((result.warnings ?? []).join("\n"));
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
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
			{loading ? (
				<p className="text-sm text-muted">{t("plugins.mcp.loading")}</p>
			) : loaded && servers.length === 0 ? (
				<Card>
					<div className="py-6 text-center">
						<Server className="mx-auto mb-2 h-8 w-8 text-muted/40" />
						<p>{t("plugins.mcp.empty")}</p>
						<p className="mt-2 text-sm text-muted">
							{t("plugins.mcp.emptyHint")}
						</p>
					</div>
				</Card>
			) : loaded ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{servers
						.filter((s) =>
							`${s.name} ${s.description ?? ""}`
								.toLowerCase()
								.includes(query.toLowerCase()),
						)
						.map((server) => (
							<Card key={server.name}>
								<div className="flex items-center justify-between gap-2">
									<h3 className="font-medium">{server.name}</h3>
									<Badge
										tone={server.state === "connected" ? "success" : "neutral"}
									>
										{t(`plugins.mcp.states.${server.state}`, server.state)}
									</Badge>
								</div>
								<p className="mt-2 text-xs text-muted">
									{server.type} ·{" "}
									{t("plugins.mcp.toolCount", { count: server.tools })}
								</p>
								{server.url && (
									<p className="mt-2 break-all font-mono text-xs text-muted">
										{server.url}
									</p>
								)}
								{server.description && (
									<p className="mt-2 text-sm">{server.description}</p>
								)}
								{server.error && (
									<p className="mt-2 break-words text-xs text-danger">
										{server.error}
									</p>
								)}
								<div className="mt-4 flex flex-wrap gap-2">
									<Button
										size="sm"
										disabled={busy}
										onClick={() => void viewTools(server.name)}
									>
										{t("plugins.mcp.tools")}
									</Button>
									{server.scope !== "extension" && (
										<>
											<Button
												size="sm"
												disabled={busy}
												onClick={() => edit(server)}
											>
												{t("plugins.mcp.edit")}
											</Button>
											<Button
												size="sm"
												disabled={busy}
												onClick={() =>
													void act(async () => {
														await command([
															"server",
															"add",
															server.name,
															...(server.scope === "project"
																? ["--local"]
																: []),
															"--config",
															JSON.stringify({
																...server.config,
																enabled: !server.enabled,
															}),
														]);
													})
												}
											>
												{t(
													server.enabled
														? "plugins.mcp.disable"
														: "plugins.mcp.enable",
												)}
											</Button>
											<Button
												size="sm"
												disabled={busy}
												onClick={() =>
													void (async () => {
														if (
															await confirmDialog({
																title: t("plugins.mcp.remove"),
																message: t("plugins.mcp.removeConfirm", {
																	name: server.name,
																}),
															})
														)
															await act(() =>
																command([
																	"server",
																	"remove",
																	server.name,
																	...(server.scope === "project"
																		? ["--local"]
																		: []),
																]),
															);
													})()
												}
											>
												{t("plugins.mcp.remove")}
											</Button>
										</>
									)}
								</div>
							</Card>
						))}
				</div>
			) : null}
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
