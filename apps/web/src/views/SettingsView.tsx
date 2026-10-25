import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import { Card, Badge, Button } from "@/components/ui";
import { confirmDialog } from "@/lib/confirm";
import { Z } from "@/lib/z-index";
import { cn, hasMacTrafficLights, isRemoteWorkspaceKey } from "@/lib/utils";
import { PixelSelect, PixelCombobox } from "@pxlkit/ui-kit";
import {
	openExternal,
	listProviders,
	setProviderApiKey,
	type AuthLoginEvent,
	type AuthLoginOption,
	listAuthLoginOptions,
	oauthLogin,
	oauthLoginAnswer,
	oauthLoginCancel,
	onAuthLoginEvent,
	removeProviderApiKey,
	saveCustomProvider,
	testCustomProvider,
	removeCustomProvider,
	checkAppUpdate,
	type AppUpdateInfo,
	getSchedulerPolicy,
	setSchedulerPolicy,
	getNetwork,
	setNetwork,
	getApprovalPolicy,
	setApprovalPolicy,
	getExtensionMenus,
	runExtensionMenuItem,
	type ExtensionMenuWire,
	type ApprovalPolicy,
	type CustomProviderInput,
	type CustomProviderTestResult,
	type ProviderInfo,
	getAvailableModels,
	testModel,
} from "@/lib/transport";
import type { ModelInfo, ModelTestResult } from "@/lib/types";
import type { RpcSessionState } from "@/lib/types";
import { appUpdateProgressLabel, startAppUpdate, useAppUpdate } from "@/lib/app-update";
import { PluginsContent } from "@/views/PluginsView";
import { PetSettingsPage } from "@/components/PetSettingsPage";
import { Key, Trash2, Eye, EyeOff, Plus, ArrowLeft, ArrowRight, ChevronRight, ChevronDown, Download, Github, Info, SlidersHorizontal, Clock, Puzzle, Search, PawPrint } from "lucide-react";
import { setTheme, useThemeId, refreshCustomThemes, type CustomTheme } from "@/lib/theme";
import {
	SUPPORTED_LANGUAGES,
	DEFAULT_LANGUAGE,
	setStoredLanguage,
	type AppLanguage,
} from "@/i18n";

function providerLabel(provider: { id: string; name?: string }): string {
	return provider.name ?? provider.id;
}

function slugifyProviderStem(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "provider";
}

function randomProviderSuffix(): string {
	const bytes = new Uint8Array(3);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

function generateCustomProviderId(name: string, existingIds: Set<string>): string {
	const stem = slugifyProviderStem(name);
	for (let attempt = 0; attempt < 12; attempt++) {
		const id = `custom-${stem}-${randomProviderSuffix()}`;
		if (!existingIds.has(id)) return id;
	}
	return `custom-${stem}-${Date.now().toString(36)}`;
}

type CustomProviderTestState =
	| { status: "idle" }
	| { status: "running"; model: string }
	| { status: "success"; result: CustomProviderTestResult }
	| { status: "error"; result?: CustomProviderTestResult; error?: string };

/** Codex-style settings group: small heading + bordered card of rows. */
function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
	return (
		<section className="mb-8">
			{title && <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-fg">{title}</h2>}
			{/* No overflow-hidden: PixelSelect popups render inline and must
			    not be clipped at the rounded corners. */}
			<div className="divide-y divide-border/60 rounded-xl border border-border bg-surface">
				{children}
			</div>
			{description && <p className="mt-2 text-xs text-muted">{description}</p>}
		</section>
	);
}

/** Codex-style settings row: title + optional description on the left, control on the right. */
function SettingsRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-6 px-4 py-3">
			<div className="min-w-0">
				<div className="text-[13px] font-medium text-fg">{title}</div>
				{description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
			</div>
			<div className="flex shrink-0 items-center gap-2">{children}</div>
		</div>
	);
}

function GeneralPage() {
	const { t, i18n } = useTranslation();
	const themeId = useThemeId();
	const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
	useEffect(() => {
		refreshCustomThemes().then(setCustomThemes).catch(() => {});
	}, []);
	// Approval policy (two states: "off" auto-runs everything; "auto"/gated
	// asks for unknown tools and dangerous commands).
	const [approvalPolicy, setApprovalPolicyState] = useState<ApprovalPolicy>("auto");
	useEffect(() => {
		getApprovalPolicy().then(setApprovalPolicyState).catch(() => {});
	}, []);
	const handlePolicySelect = useCallback((policy: ApprovalPolicy) => {
		setApprovalPolicyState(policy);
		void setApprovalPolicy(policy).catch(() => {});
	}, []);

	// Proxy for channel adapters — "auto" (env/OS detection), "off" (direct),
	// or a custom URL. Edits write settings.json; the gateway watches the file
	// and respawns adapters so the change applies immediately.
	const [proxyMode, setProxyMode] = useState<string>("auto");
	const [proxyUrl, setProxyUrl] = useState("");
	const networkLoadedRef = useRef(false);
	useEffect(() => {
		getNetwork()
			.then((n) => {
				const p = n.proxy ?? "auto";
				if (p === "auto" || p === "off") {
					setProxyMode(p);
				} else {
					setProxyMode("custom");
					setProxyUrl(p);
				}
				networkLoadedRef.current = true;
			})
			.catch(() => {});
	}, []);
	const saveNetwork = useCallback((mode: string, url: string) => {
		if (!networkLoadedRef.current) return;
		const proxy = mode === "custom" ? url.trim() || "auto" : mode;
		void setNetwork({ proxy }).catch(() => {});
	}, []);

	const [language, setLanguage] = useState<AppLanguage>(
		(SUPPORTED_LANGUAGES.includes(i18n.language as AppLanguage) ? i18n.language : DEFAULT_LANGUAGE) as AppLanguage,
	);

	const handleLanguageChange = useCallback((value: string) => {
		const lang = (SUPPORTED_LANGUAGES.includes(value as AppLanguage) ? value : DEFAULT_LANGUAGE) as AppLanguage;
		setLanguage(lang);
		setStoredLanguage(lang);
		void i18n.changeLanguage(lang);
	}, [i18n]);

	const languageOptions = SUPPORTED_LANGUAGES.map((lang) => ({
		value: lang,
		label: t(`language.${lang}`),
	}));

	return (
		<>
			<SettingsSection title={t("settings.general.language")}>
				<SettingsRow title={t("settings.general.languageDescription")}>
					<div className="w-36">
						<PixelSelect
							value={language}
							options={languageOptions}
							onChange={handleLanguageChange}
							size="sm"
							tone="cyan"
						/>
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.general.theme")}>
				<SettingsRow title={t("settings.general.themeLabel")}>
					<div className="w-36">
						<PixelSelect
							value={themeId}
							options={[
								{ value: "light", label: t("theme.light") },
								{ value: "dark", label: t("theme.dark") },
								...customThemes.map((ct) => ({ value: ct.name, label: ct.label })),
							]}
							onChange={(value) => setTheme(value)}
							size="sm"
							tone="cyan"
						/>
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.general.approval.title")} description={t("settings.general.approval.subtitle")}>
				<SettingsRow title={t("settings.general.approval.policy")}>
					<div className="w-44">
						<PixelSelect
							value={approvalPolicy}
							options={[
								{ value: "auto", label: t("composer.approvalGated") },
								{ value: "off", label: t("composer.approvalOff") },
							]}
							onChange={(value) => handlePolicySelect(value as ApprovalPolicy)}
							size="sm"
							tone="cyan"
						/>
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.network.title")} description={t("settings.network.subtitle")}>
				<SettingsRow title={t("settings.network.proxy")}>
					<div className="w-44">
						<PixelSelect
							value={proxyMode}
							options={[
								{ value: "auto", label: t("settings.network.proxyAuto") },
								{ value: "custom", label: t("settings.network.proxyCustom") },
								{ value: "off", label: t("settings.network.proxyOff") },
							]}
							onChange={(value) => {
								setProxyMode(value);
								saveNetwork(value, proxyUrl);
							}}
							size="sm"
							tone="cyan"
						/>
					</div>
				</SettingsRow>
				{proxyMode === "custom" && (
					<SettingsRow title={t("settings.network.proxyUrl")} description={t("settings.network.proxyUrlHint")}>
						<input
							type="text"
							value={proxyUrl}
							onChange={(e) => setProxyUrl(e.target.value)}
							onBlur={() => saveNetwork("custom", proxyUrl)}
							onKeyDown={(e) => {
								if (e.key === "Enter") saveNetwork("custom", proxyUrl);
							}}
							placeholder="http://127.0.0.1:7897"
							className="h-8 w-56 rounded-lg border border-border bg-bg px-2 font-mono text-sm text-fg outline-none focus:border-muted"
						/>
					</SettingsRow>
				)}
			</SettingsSection>
		</>
	);
}

function SchedulerPage() {
	const { t } = useTranslation();
	// Scheduler defaults — applied to new tasks. Loaded once on mount.
	const [schedulerPolicy, setSchedulerPolicyState] = useState<import("@/lib/types").SchedulerPolicy>({
		concurrency: "skip",
		timeoutMinutes: 0,
		defaultSessionTarget: { kind: "pinned" },
	});
	const schedulerLoadedRef = useRef(false);
	useEffect(() => {
		getSchedulerPolicy()
			.then((policy) => {
				setSchedulerPolicyState({
					...policy,
					defaultSessionTarget: policy.defaultSessionTarget.kind === "current"
						? { kind: "pinned" }
						: policy.defaultSessionTarget,
				});
				schedulerLoadedRef.current = true;
			})
			.catch(() => {});
	}, []);

	// Auto-save scheduler policy on every change (consistent with thinking/language
	// which also apply immediately). Skips the initial load to avoid clobbering
	// server-side defaults before we've fetched them.
	const updateScheduler = useCallback(async (next: import("@/lib/types").SchedulerPolicy) => {
		setSchedulerPolicyState(next);
		if (!schedulerLoadedRef.current) return;
		try {
			const saved = await setSchedulerPolicy(next);
			setSchedulerPolicyState(saved);
		} catch (e) {
			console.error("[settings] setSchedulerPolicy failed:", e);
		}
	}, []);

	return (
		<SettingsSection title={t("settings.scheduler.title")} description={t("settings.scheduler.subtitle")}>
			<SettingsRow title={t("settings.scheduler.defaultSessionTarget")}>
				<div className="w-40">
					<PixelSelect
						value={schedulerPolicy.defaultSessionTarget.kind === "new" ? "new" : "pinned"}
						options={[
							{ value: "pinned", label: t("schedule.sessionPinned") },
							{ value: "new", label: t("schedule.sessionNew") },
						]}
						onChange={(value) => updateScheduler({
							...schedulerPolicy,
							defaultSessionTarget: value === "pinned"
								? { kind: "pinned" }
								: { kind: "new", purpose: schedulerPolicy.defaultSessionTarget.kind === "new" ? schedulerPolicy.defaultSessionTarget.purpose : "" },
						})}
						size="sm"
						tone="cyan"
					/>
				</div>
			</SettingsRow>
			<SettingsRow title={t("settings.scheduler.defaultConcurrency")}>
				<div className="w-40">
					<PixelSelect
						value={schedulerPolicy.concurrency}
						options={(["skip", "queue", "preempt"] as const).map((p) => ({ value: p, label: t(`schedule.concurrency_${p}`) }))}
						onChange={(value) => updateScheduler({ ...schedulerPolicy, concurrency: value as import("@/lib/types").SchedulerPolicy["concurrency"] })}
						size="sm"
						tone="cyan"
					/>
				</div>
			</SettingsRow>
			<SettingsRow
				title={t("settings.scheduler.defaultTimeout")}
				description={`${t("schedule.minute")} (0 = ${t("schedule.timeoutNoLimit")})`}
			>
				<input
					type="number"
					min={0}
					max={1440}
					value={schedulerPolicy.timeoutMinutes}
					onChange={(e) => updateScheduler({ ...schedulerPolicy, timeoutMinutes: Math.max(0, Number(e.target.value || 0)) })}
					className="h-8 w-24 rounded-lg border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-muted"
				/>
			</SettingsRow>
		</SettingsSection>
	);
}

const PIZZA_REPO_URL = "https://github.com/pizza-agent/pizza";

function AboutPage() {
	const { t } = useTranslation();
	// Desktop app update check (GitHub releases). Auto-runs once on mount;
	// when a newer release exists a single update button appears — there is
	// no manual "check now" control. Stays null outside Tauri.
	const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
	const update = useAppUpdate();
	useEffect(() => {
		let alive = true;
		void checkAppUpdate().then((info) => {
			if (alive) setUpdateInfo(info);
		});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<SettingsSection>
			<SettingsRow title="Pizza" description={t("settings.about.tagline")}>
				<span className="shrink-0 font-mono text-[13px] text-muted">
					v{updateInfo?.currentVersion ?? "—"}
				</span>
			</SettingsRow>
			<SettingsRow title={t("settings.about.repository")}>
				<button
					type="button"
					onClick={() => void openExternal(PIZZA_REPO_URL)}
					className="flex items-center gap-1.5 text-[13px] text-link hover:underline"
				>
					<Github className="h-3.5 w-3.5" />
					pizza-agent/pizza
				</button>
			</SettingsRow>
			<SettingsRow title={t("settings.about.license")}>
				<span className="text-[13px] text-muted">MIT</span>
			</SettingsRow>
			{updateInfo?.updateAvailable && (
				<SettingsRow
					title={t("settings.about.updateAvailable", { version: updateInfo.latestVersion })}
					description={update.status === "error" ? t("update.failed", { error: update.error }) : undefined}
				>
					<div className="flex shrink-0 items-center gap-2">
						{update.status === "error" && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => void openExternal(updateInfo.downloadUrl ?? updateInfo.releaseUrl)}
							>
								{t("update.manualDownload")}
							</Button>
						)}
						<Button
							size="sm"
							loading={update.status === "running"}
							disabled={update.status === "running"}
							iconLeft={<Download className="h-3.5 w-3.5" />}
							onClick={() => void startAppUpdate()}
						>
							{appUpdateProgressLabel(t, update) ??
								(update.status === "error"
									? t("update.retry")
									: t("settings.about.updateTo", { version: updateInfo.latestVersion }))}
						</Button>
					</div>
				</SettingsRow>
			)}
		</SettingsSection>
	);
}

/**
 * "Sign in with an account" dialog — drives the CLI OAuth flow
 * (`pizza auth login --mode jsonl`) via bridge events.
 */
function AccountLoginDialog({
	provider,
	providerName,
	onDone,
	onCancel,
}: {
	provider: string;
	providerName: string;
	onDone: (ok: boolean, message?: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [status, setStatus] = useState("");
	const [authUrl, setAuthUrl] = useState("");
	const [instructions, setInstructions] = useState("");
	const [prompt, setPrompt] = useState<AuthLoginEvent | null>(null);
	const [answer, setAnswer] = useState("");
	const [busy, setBusy] = useState(true);

	useEffect(() => {
		const dispose = onAuthLoginEvent((event) => {
			if (event.type === "prompt") {
				setPrompt(event);
				setAnswer("");
				setBusy(false);
			} else if (event.type === "event") {
				const e = event.event;
				if (e.type === "auth_url" && e.url) {
					setAuthUrl(e.url);
					if (e.instructions) setInstructions(e.instructions);
				} else if (e.type === "device_code" && e.verificationUri) {
					setAuthUrl(e.verificationUri);
					setInstructions(`Enter code: ${e.userCode ?? ""}`);
				} else if (e.message) {
					setStatus(e.message);
				}
			} else if (event.type === "done") {
				setBusy(false);
				onDone(event.ok, event.error);
			}
		});
		void oauthLogin(provider).catch((e) => {
			setBusy(false);
			onDone(false, e instanceof Error ? e.message : String(e));
		});
		return dispose;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [provider]);

	const submitAnswer = useCallback(async () => {
		if (!prompt || prompt.type !== "prompt") return;
		const value = answer.trim();
		if (!value) return;
		setBusy(true);
		setPrompt(null);
		try {
			await oauthLoginAnswer(value);
		} catch (e) {
			setBusy(false);
			onDone(false, e instanceof Error ? e.message : String(e));
		}
	}, [answer, prompt, onDone]);

	return (
		<div className={cn("fixed inset-0 flex items-center justify-center bg-black/50 p-4", Z.modal)}>
			<Card className="w-full max-w-lg">
				<div className="mb-3 text-sm font-medium text-fg">
					{t("settings.provider.accountLoginTitle", { name: providerName })}
				</div>
				{authUrl && (
					<div className="mb-3 space-y-1">
						<a href={authUrl} target="_blank" rel="noreferrer" className="break-all text-xs text-link underline">
							{authUrl}
						</a>
						{instructions && <p className="text-xs text-muted">{instructions}</p>}
					</div>
				)}
				{status && <p className="mb-3 text-xs text-muted">{status}</p>}
				{prompt?.type === "prompt" ? (
					<div className="space-y-2">
						{prompt.prompt.options ? (
							<div className="space-y-1">
								{prompt.prompt.options.map((o) => (
									<button
										key={o.id}
										onClick={() => {
											setAnswer(o.id);
											setTimeout(() => void submitAnswer(), 0);
										}}
										className="block w-full rounded-md border border-border bg-surface px-3 py-1.5 text-left text-xs text-fg hover:border-accent"
									>
										{o.label}
									</button>
								))}
							</div>
						) : (
							<div className="flex items-center gap-2">
								<input
									autoFocus
									value={answer}
									onChange={(e) => setAnswer(e.target.value)}
									placeholder={prompt.prompt.placeholder ?? prompt.prompt.message}
									className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
									onKeyDown={(e) => e.key === "Enter" && void submitAnswer()}
								/>
								<Button size="sm" tone="accent" onClick={() => void submitAnswer()} disabled={busy}>
									{t("common.continue")}
								</Button>
							</div>
						)}
					</div>
				) : (
					<p className="font-mono text-[10px] text-muted">
						{busy ? t("settings.provider.loginWaiting") : t("settings.provider.loginIdle")}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<Button
						size="sm"
						tone="neutral"
						onClick={() => {
							void oauthLoginCancel().catch(() => {});
							onCancel();
						}}
					>
						{t("common.cancel")}
					</Button>
				</div>
			</Card>
		</div>
	);
}

type ModelTestState = { status: "running" } | { status: "done"; result: ModelTestResult };

function formatContextWindow(size: number | undefined): string {
	if (!size || size <= 0) return "";
	const k = Math.round(size / 1000);
	return `${k}k`;
}

/**
 * One configured provider. The header shows identity + auth state; expanding
 * it lists the provider's models (merged from the sidecar's live registry)
 * with a per-model connectivity test that goes through the real auth
 * pipeline, so what passes here is what will work in chat.
 */
function ProviderRow({
	provider,
	models,
	modelsAvailable,
	expanded,
	onToggle,
	onRefresh,
}: {
	provider: ProviderInfo;
	models: ModelInfo[];
	modelsAvailable: boolean;
	expanded: boolean;
	onToggle: () => void;
	onRefresh: (expandId?: string) => void;
}) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [testStates, setTestStates] = useState<Record<string, ModelTestState>>({});
	const [batchRunning, setBatchRunning] = useState(false);

	const handleSave = useCallback(async () => {
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(provider.id, keyValue.trim());
			setEditing(false);
			setKeyValue("");
			setShowKey(false);
			// Expand so the model list and its test buttons are right there —
			// the natural next step after (re)entering a key.
			onRefresh(provider.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [keyValue, provider.id, onRefresh, t]);

	const handleRemove = useCallback(async () => {
		const ok = await confirmDialog({
			title: t("common.remove"),
			message: t("settings.provider.confirmRemove", { label: providerLabel(provider) }),
			confirmLabel: t("common.remove"),
			danger: true,
		});
		if (!ok) return;
		try {
			if (provider.is_custom) {
				await removeCustomProvider(provider.id);
			} else {
				await removeProviderApiKey(provider.id);
			}
			onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [provider, onRefresh, t]);

	const runTest = useCallback(async (modelId: string) => {
		setTestStates((prev) => ({ ...prev, [modelId]: { status: "running" } }));
		try {
			const result = await testModel(provider.id, modelId);
			setTestStates((prev) => ({ ...prev, [modelId]: { status: "done", result } }));
		} catch (e) {
			setTestStates((prev) => ({
				...prev,
				[modelId]: {
					status: "done",
					result: {
						ok: false,
						provider: provider.id,
						modelId,
						error: e instanceof Error ? e.message : String(e),
						latencyMs: 0,
					},
				},
			}));
		}
	}, [provider.id]);

	const testableModels = models.filter((m) => m.hasAuth !== false);

	const runAllTests = useCallback(async () => {
		if (testableModels.length === 0) return;
		setBatchRunning(true);
		try {
			// Sequential — kinder to provider rate limits, and the progress is
			// readable top to bottom as each row settles.
			for (const m of testableModels) {
				await runTest(m.id);
			}
		} finally {
			setBatchRunning(false);
		}
	}, [testableModels, runTest]);

	const label = providerLabel(provider);
	const testResults = Object.values(testStates).filter((s) => s.status === "done");
	const passCount = testResults.filter((s) => s.result.ok).length;
	const anyRunning = batchRunning || Object.values(testStates).some((s) => s.status === "running");

	return (
		<div className="border-b border-border/60 py-3 last:border-0">
			<div className="flex items-center justify-between">
				<div className="flex min-w-0 items-center gap-2">
					<Key className={cn("h-4 w-4 shrink-0", provider.has_api_key ? "text-success" : "text-muted")} />
					<span className="text-sm font-medium text-fg">{label}</span>
					{provider.has_api_key ? (
						<Badge tone={provider.auth_type === "oauth" ? "accent" : "success"}>
							{provider.auth_type === "oauth" ? t("settings.provider.oauth") : t("settings.provider.apiKey")}
						</Badge>
					) : (
						<Badge tone="neutral">{t("settings.provider.notConfigured")}</Badge>
					)}
					{provider.is_custom && (
						<Badge tone="accent">
							{provider.protocol === "anthropic"
								? t("settings.provider.protocolAnthropic")
								: t("settings.provider.protocolOpenAI")}
						</Badge>
					)}
					{models.length > 0 && (
						<button
							onClick={onToggle}
							className="flex items-center gap-0.5 font-mono text-[10px] text-muted transition-colors hover:text-fg"
							title={t("settings.provider.modelListTitle")}
						>
							<ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
							{t("settings.provider.modelCount", { count: models.length })}
						</button>
					)}
				</div>
				<div className="flex items-center gap-2">
					{!editing && provider.auth_type !== "oauth" && (
						<Button size="sm" tone="neutral" onClick={() => setEditing(true)}>
							{provider.has_api_key ? t("settings.provider.update") : t("settings.provider.configure")}
						</Button>
					)}
					{provider.has_api_key && provider.auth_type !== "oauth" && !editing && (
						<button
							onClick={handleRemove}
							className="text-muted hover:text-danger transition-colors"
							title={t("settings.provider.remove")}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
			</div>
			{expanded && (
				<div className="mt-2 rounded-lg border border-border/60 bg-bg/60 px-3 py-2">
					<div className="mb-1 flex items-center justify-between border-b border-border/40 pb-1.5">
						<span className="text-[11px] text-muted">
							{t("settings.provider.modelListTitle")}
							{testResults.length > 0 && (
								<span className={cn("ml-2", passCount === testResults.length ? "text-success" : "text-danger")}>
									{passCount}/{testResults.length}
								</span>
							)}
						</span>
						{testableModels.length > 0 && (
							<Button size="sm" tone="neutral" onClick={runAllTests} disabled={anyRunning}>
								{batchRunning ? t("settings.provider.testing") : t("settings.provider.testAll")}
							</Button>
						)}
					</div>
					{models.length === 0 ? (
						<p className="py-2 text-xs text-muted">
							{modelsAvailable
								? t("settings.provider.noModels")
								: t("settings.provider.modelsUnavailable")}
						</p>
					) : (
						<div className="divide-y divide-border/30">
							{models.map((m) => {
								const state = testStates[m.id];
								const running = state?.status === "running";
								const done = state?.status === "done" ? state.result : null;
								return (
									<div key={m.id} className="py-1.5">
										<div className="flex items-center justify-between gap-3">
											<div className="flex min-w-0 items-center gap-2">
												<span className="truncate font-mono text-xs text-fg" title={m.name !== m.id ? m.name : undefined}>
													{m.id}
												</span>
												{m.reasoning && (
													<span className="shrink-0 rounded border border-border px-1 py-px text-[9px] text-muted">
														{t("settings.provider.reasoning")}
													</span>
												)}
												{formatContextWindow(m.contextWindow) && (
													<span className="shrink-0 font-mono text-[10px] text-muted">
														{t("settings.provider.contextWindow", { size: formatContextWindow(m.contextWindow) })}
													</span>
												)}
												{m.hasAuth === false && (
													<span className="shrink-0 text-[10px] text-muted">{t("settings.provider.notConfigured")}</span>
												)}
											</div>
											<div className="flex shrink-0 items-center gap-2">
												{done && done.ok && (
													<span className="font-mono text-[10px] text-success">
														✓ {t("settings.provider.testDuration", { ms: done.latencyMs })}
													</span>
												)}
												{done && !done.ok && (
													<span className="font-mono text-[10px] text-danger">✗ {t("settings.provider.testFailedShort")}</span>
												)}
												{m.hasAuth !== false && (
													<Button size="sm" tone="neutral" onClick={() => runTest(m.id)} disabled={anyRunning}>
														{running ? t("settings.provider.testing") : t("settings.provider.testModelBtn")}
													</Button>
												)}
											</div>
										</div>
										{done && (done.response || done.error) && (
											<div
												className={cn(
													"select-text mt-1 break-all font-mono text-[10px] leading-4",
													done.ok ? "text-muted" : "text-danger/80",
												)}
											>
												{done.ok ? done.response : done.error}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}
			{editing && (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							placeholder={t("settings.provider.enterKey", { label })}
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					{error && <p className="text-xs text-danger">{error}</p>}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={() => { setEditing(false); setKeyValue(""); setShowKey(false); setError(""); }}>
							{t("settings.provider.cancel")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function AddProviderInline({
	available,
	existingIds,
	onSaved,
	onCancel,
}: {
	available: ProviderInfo[];
	existingIds: Set<string>;
	onSaved: (providerId: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<"builtin" | "custom">("builtin");
	const [selected, setSelected] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [customName, setCustomName] = useState("");
	const [customProtocol, setCustomProtocol] = useState<"openai" | "anthropic">("openai");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customModels, setCustomModels] = useState("");
	const [testState, setTestState] = useState<CustomProviderTestState>({ status: "idle" });

	const providerOptions = available.map((p) => ({
		value: p.id,
		label: providerLabel(p),
	}));

	const selectedProvider = available.find((p) => p.id === selected);
	const label = selectedProvider ? providerLabel(selectedProvider) : "";

	const protocolOptions = [
		{ value: "openai", label: t("settings.provider.protocolOpenAI") },
		{ value: "anthropic", label: t("settings.provider.protocolAnthropic") },
	];

	const buildCustomProviderInput = useCallback((): CustomProviderInput | null => {
		const name = customName.trim();
		const models = customModels
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter(Boolean)
			.map((id) => ({ id, name: id }));
		if (!name) {
			setError(t("settings.provider.customNameEmpty"));
			return null;
		}
		if (!customBaseUrl.trim()) {
			setError(t("settings.provider.baseUrlEmpty"));
			return null;
		}
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return null;
		}
		if (models.length === 0) {
			setError(t("settings.provider.modelsEmpty"));
			return null;
		}
		setError("");
		return {
			id: generateCustomProviderId(name, existingIds),
			name,
			protocol: customProtocol,
			base_url: customBaseUrl.trim(),
			api_key: keyValue.trim(),
			models,
		};
	}, [customName, customModels, customBaseUrl, keyValue, t, existingIds, customProtocol]);

	const handleTest = useCallback(async () => {
		const input = buildCustomProviderInput();
		if (!input) return;
		setTestState({ status: "running", model: input.models[0]?.id ?? "" });
		try {
			const result = await testCustomProvider(input);
			setTestState(result.ok ? { status: "success", result } : { status: "error", result });
		} catch (e) {
			setTestState({ status: "error", error: e instanceof Error ? e.message : String(e) });
		}
	}, [buildCustomProviderInput]);

	const handleSave = useCallback(async () => {
		if (mode === "custom") {
			const input = buildCustomProviderInput();
			if (!input) return;
			setSaving(true);
			setError("");
			try {
				await saveCustomProvider(input);
				onSaved(input.id);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setSaving(false);
			}
			return;
		}

		if (!selected) {
			setError(t("settings.provider.selectProvider"));
			return;
		}
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(selected, keyValue.trim());
			onSaved(selected);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [mode, selected, keyValue, onSaved, t, buildCustomProviderInput]);

	return (
		<div className="border-b border-border/60 py-3">
			<div className="mb-2 flex items-center justify-between gap-3">
				<div className="text-xs font-medium text-fg">{t("settings.provider.addNew")}</div>
				<div className="flex items-center gap-1">
					<Button size="sm" tone={mode === "builtin" ? "accent" : "neutral"} onClick={() => { setMode("builtin"); setError(""); }}>
						{t("settings.provider.builtinProvider")}
					</Button>
					<Button size="sm" tone={mode === "custom" ? "accent" : "neutral"} onClick={() => { setMode("custom"); setError(""); }}>
						{t("settings.provider.customProvider")}
					</Button>
				</div>
			</div>

			{mode === "builtin" ? (
				<>
					<div className="flex items-center gap-2">
						<div className="flex-1">
							<PixelCombobox
								value={selected}
								options={providerOptions}
								onChange={(v) => { setSelected(v); setError(""); }}
								placeholder={t("settings.provider.selectProviderPlaceholder")}
								size="sm"
								emptyMessage={t("settings.provider.noMatch")}
							/>
						</div>
						{!selected && (
							<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
						)}
					</div>
					{selected && (
						<div className="mt-3 space-y-2">
							<div className="flex items-center gap-2">
								<input
									type={showKey ? "text" : "password"}
									value={keyValue}
									onChange={(e) => setKeyValue(e.target.value)}
									placeholder={t("settings.provider.enterKey", { label })}
									autoFocus
									className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
									onKeyDown={(e) => e.key === "Enter" && handleSave()}
								/>
								<button
									onClick={() => setShowKey(!showKey)}
									className="text-muted hover:text-fg transition-colors"
									title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
								>
									{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
								</button>
							</div>
							{error && <p className="text-xs text-danger">{error}</p>}
							<div className="flex items-center gap-2">
								<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
									{saving ? t("settings.provider.saving") : t("settings.provider.save")}
								</Button>
								<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
							</div>
						</div>
					)}
				</>
			) : (
				<div className="mt-3 space-y-2">
					<input
						value={customName}
						onChange={(e) => { setCustomName(e.target.value); setTestState({ status: "idle" }); }}
						placeholder={t("settings.provider.customNamePlaceholder")}
						autoFocus
						className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					<div className="grid gap-2 md:grid-cols-[180px_1fr]">
						<PixelSelect
							value={customProtocol}
							options={protocolOptions}
							onChange={(v) => { setCustomProtocol(v as "openai" | "anthropic"); setTestState({ status: "idle" }); }}
							size="sm"
							tone="cyan"
						/>
						<input
							value={customBaseUrl}
							onChange={(e) => { setCustomBaseUrl(e.target.value); setTestState({ status: "idle" }); }}
							placeholder={customProtocol === "anthropic" ? t("settings.provider.anthropicBaseUrlPlaceholder") : t("settings.provider.openAIBaseUrlPlaceholder")}
							className="rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</div>
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => { setKeyValue(e.target.value); setTestState({ status: "idle" }); }}
							placeholder={t("settings.provider.enterKey", { label: customName || t("settings.provider.customProvider") })}
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					<textarea
						value={customModels}
						onChange={(e) => { setCustomModels(e.target.value); setTestState({ status: "idle" }); }}
						placeholder={t("settings.provider.modelsPlaceholder")}
						rows={3}
						className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					{error && <p className="text-xs text-danger">{error}</p>}
					{testState.status !== "idle" && (
						<div className="select-text rounded-md border border-border bg-[#0f1725] px-3 py-2 font-mono text-xs leading-6">
							<div className="text-sky-300">{t("settings.provider.testStart", { name: customName.trim() || t("settings.provider.customProvider") })}</div>
							<div className="text-slate-300">{t("settings.provider.testAuthType")}</div>
							<div className={testState.status === "error" ? "text-danger" : "text-success"}>
								{testState.status === "running"
									? t("settings.provider.testConnecting")
									: testState.status === "success"
										? t("settings.provider.testConnected")
										: t("settings.provider.testFailed")}
							</div>
							<div className="text-cyan-300">
								{t("settings.provider.testModel", {
									model: testState.status === "running" ? testState.model : testState.result?.model ?? "",
								})}
							</div>
							<div className="text-slate-400">{t("settings.provider.testMessage")}</div>
							{testState.status !== "running" && testState.result?.response && (
								<>
									<div className="text-yellow-300">{t("settings.provider.testResponse")}</div>
									<div className="whitespace-pre-wrap text-green-200">{testState.result.response}</div>
								</>
							)}
							<div className="mt-2 border-t border-slate-600 pt-2">
								<span className={testState.status === "success" ? "text-success" : testState.status === "running" ? "text-slate-300" : "text-danger"}>
									{testState.status === "running"
										? t("settings.provider.testRunning")
										: testState.status === "success"
											? t("settings.provider.testDone")
											: testState.result?.message ?? testState.error ?? t("settings.provider.testFailed")}
								</span>
								{testState.status !== "running" && testState.result?.duration_ms !== undefined && (
									<span className="ml-2 text-slate-400">
										{t("settings.provider.testDuration", { ms: testState.result.duration_ms })}
									</span>
								)}
							</div>
						</div>
					)}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="neutral" onClick={handleTest} disabled={testState.status === "running" || saving}>
							{testState.status === "running" ? t("settings.provider.testing") : t("settings.provider.testConnection")}
						</Button>
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function ProviderTab({
	isSetupMode = false,
	onConfigured,
}: {
	isSetupMode?: boolean;
	onConfigured?: () => void | Promise<void>;
}) {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [accountOptions, setAccountOptions] = useState<AuthLoginOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [showAddInline, setShowAddInline] = useState(isSetupMode);
	const [loginProvider, setLoginProvider] = useState<{ id: string; name: string } | null>(null);
	const [authCategory, setAuthCategory] = useState<"account" | "apiKey" | null>(null);
	// Models merged from the sidecar's live registry, keyed per provider for
	// the expandable rows. `modelsLoaded` distinguishes "provider really has no
	// models" from "sidecar data unavailable (not ready yet)".
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [modelsLoaded, setModelsLoaded] = useState(false);
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

	const refresh = useCallback(async () => {
		try {
			const list = await listProviders();
			setProviders(list);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
		// Best-effort: until the sidecar is ready (first-run setup, restart)
		// this rejects and rows show a hint instead of a model list.
		getAvailableModels()
			.then((r) => {
				setModels(r.models);
				setModelsLoaded(true);
			})
			.catch(() => setModelsLoaded(false));
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => {
		listAuthLoginOptions()
			.then((options) => setAccountOptions(options.filter((o) => o.kind === "account")))
			.catch(() => setAccountOptions([]));
	}, []);

	const expandProvider = useCallback((id: string) => {
		setExpandedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);
	const toggleExpanded = useCallback((id: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);
	const modelsFor = useCallback((id: string) => models.filter((m) => m.provider === id), [models]);

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("settings.provider.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("settings.provider.error", { error })}</div>
			</Card>
		);
	}

	const configured = providers.filter((p) => p.has_api_key);
	const available = providers.filter((p) => !p.has_api_key);

	const oauthSignedIn = new Set(
		providers.filter((p) => p.has_api_key && p.auth_type === "oauth").map((p) => p.id),
	);

	// Leave for chat only in the first-run setup flow. Everywhere else we stay
	// so the user can see the provider's model list and run connectivity tests;
	// the bridge's reload_providers broadcast keeps the sidecar registry fresh
	// without a restart.
	const handleConfiguredInSetup = () => {
		if (isSetupMode && onConfigured) void onConfigured();
	};

	return (
		<div className="space-y-6">
			{loginProvider && (
				<AccountLoginDialog
					provider={loginProvider.id}
					providerName={loginProvider.name}
					onDone={(ok, message) => {
						const id = loginProvider.id;
						setLoginProvider(null);
						refresh();
						if (!ok && message) setError(message);
						if (ok) expandProvider(id);
						if (ok) handleConfiguredInSetup();
					}}
					onCancel={() => setLoginProvider(null)}
				/>
			)}
			{authCategory === null ? (
				<Card>
					<div className="mb-3 text-sm font-medium text-fg">{t("settings.provider.chooseCategory")}</div>
					<div className="grid gap-3 sm:grid-cols-2">
						{accountOptions.length > 0 && (
							<button
								onClick={() => setAuthCategory("account")}
								className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
							>
								<div className="text-sm font-medium text-fg">{t("settings.provider.accountSection")}</div>
								<div className="mt-1 text-xs text-muted">{t("settings.provider.accountSectionHint")}</div>
							</button>
						)}
						<button
							onClick={() => setAuthCategory("apiKey")}
							className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
						>
							<div className="text-sm font-medium text-fg">{t("settings.provider.apiKeySection")}</div>
							<div className="mt-1 text-xs text-muted">{t("settings.provider.apiKeySectionHint")}</div>
						</button>
					</div>
				</Card>
			) : authCategory === "account" ? (
				<Card>
					<div className="mb-3 flex items-center justify-between">
						<div className="text-sm font-medium text-fg">{t("settings.provider.accountSection")}</div>
						<Button size="sm" tone="neutral" onClick={() => setAuthCategory(null)}>
							{t("common.back")}
						</Button>
					</div>
					<div className="space-y-0">
						{accountOptions.map((o) => (
							<div key={o.id} className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-fg">{o.name}</span>
									{oauthSignedIn.has(o.id) ? (
										<Badge tone="accent">{t("settings.provider.oauth")}</Badge>
									) : (
										<Badge tone="neutral">{t("settings.provider.notConfigured")}</Badge>
									)}
								</div>
								{oauthSignedIn.has(o.id) ? (
									<Button
										size="sm"
										tone="neutral"
										onClick={() => {
											void removeProviderApiKey(o.id)
												.then(() => refresh())
												.catch((e) => setError(e instanceof Error ? e.message : String(e)));
										}}
									>
										{t("settings.provider.signOut")}
									</Button>
								) : (
									<Button size="sm" tone="accent" onClick={() => setLoginProvider({ id: o.id, name: o.name })}>
										{t("settings.provider.signIn")}
									</Button>
								)}
							</div>
						))}
					</div>
				</Card>
			) : (
			<Card>
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium text-fg">{t("settings.provider.apiKeySection")}</div>
					<div className="flex items-center gap-2">
						{!isSetupMode && (
							<Button size="sm" tone="accent" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddInline(true)}>
								{t("settings.provider.addProvider")}
							</Button>
						)}
						<Button size="sm" tone="neutral" onClick={() => setAuthCategory(null)}>
							{t("common.back")}
						</Button>
					</div>
				</div>

				{showAddInline && (
					<AddProviderInline
						available={available}
						existingIds={new Set(providers.map((p) => p.id))}
						onSaved={(providerId) => {
							setShowAddInline(false);
							refresh();
							expandProvider(providerId);
							handleConfiguredInSetup();
						}}
						onCancel={() => setShowAddInline(false)}
					/>
				)}

				{configured.length === 0 && !showAddInline && (
					<div className="py-6 text-center">
						<p className="text-xs text-muted">{t("settings.provider.noProviders")}</p>
						<p className="mt-1 text-xs text-muted">{t("settings.provider.noProvidersHint")}</p>
					</div>
				)}

				{configured.map((p) => (
					<ProviderRow
						key={p.id}
						provider={p}
						models={modelsFor(p.id)}
						modelsAvailable={modelsLoaded}
						expanded={expandedIds.has(p.id)}
						onToggle={() => toggleExpanded(p.id)}
						onRefresh={(expandId) => {
							refresh();
							if (expandId) expandProvider(expandId);
						}}
					/>
				))}
			</Card>
			)}
		</div>
	);
}

function SetupBanner({ state }: { state: RpcSessionState | null }) {
	const { t } = useTranslation();
	const isSetup = !state || state.model === undefined;
	if (!isSetup) return null;
	return (
		<Card className="border-accent/40 bg-accent/5">
			<div className="flex items-start gap-3">
				<Key className="mt-0.5 h-5 w-5 text-accent" />
				<div className="flex-1 space-y-1">
					<div className="text-sm font-medium text-fg">{t("settings.setup.bannerTitle")}</div>
					<div className="text-xs text-muted">{t("settings.setup.bannerBody")}</div>
				</div>
			</div>
		</Card>
	);
}

/** Settings page for an extension-contributed menu: each item is a row that
 *  shows its live value and runs its command/uiCommand when picked. */
function ExtensionMenuPage({ menu, onAction }: { menu: ExtensionMenuWire; onAction: () => void }) {
	return (
		<SettingsSection title={menu.label} description={menu.description}>
			{menu.items.map((item) => {
				const actionable = Boolean(item.command || item.uiCommand);
				return (
					<SettingsRow key={item.id} title={item.label} description={item.description}>
						{item.value && <span className="text-xs text-muted">{item.value}</span>}
						{actionable && (
							<button
								type="button"
								onClick={() => {
									runExtensionMenuItem(item);
									onAction();
								}}
								title={item.description ?? item.label}
								className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							>
								<ChevronRight className="h-4 w-4" />
							</button>
						)}
					</SettingsRow>
				);
			})}
		</SettingsSection>
	);
}

type SettingsPageId = "general" | "pet" | "scheduler" | "about" | "provider" | "plugins";
/** Static pages plus extension-contributed pages addressed as `ext:<menuId>`. */
type SettingsPage = SettingsPageId | `ext:${string}`;
const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = ["general", "pet", "scheduler", "about", "provider", "plugins"];
const EXT_PAGE_PREFIX = "ext:";

export default function SettingsView({
	state,
	workspace,
	onRestartSidecar,
}: {
	state: RpcSessionState | null;
	workspace?: string;
	onRestartSidecar?: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	// Settings owns the full window (the app sidebar is hidden on this route),
	// so the top bar clears the macOS traffic lights directly.
	const macPad = hasMacTrafficLights();
	// First-run / unconfigured-key setup mode is signaled by ?setup=true in the
	// URL. App.tsx redirects there when the sidecar reports state.model === undefined.
	const isSetupMode = new URLSearchParams(location.search).get("setup") === "true";
	const isRemoteWorkspace = isRemoteWorkspaceKey(workspace);
	// The selected page lives in the URL (?page=) so refreshes, deep links and
	// the top bar's back/forward buttons all agree on what is shown.
	const pageParam = new URLSearchParams(location.search).get("page");
	// "updates" is the pre-rename id for the About page; keep accepting it so
	// old deep links still land somewhere sensible.
	// "ext:pet" predates the pet becoming a core page.
	const normalizedPageParam = pageParam === "updates" ? "about" : pageParam === "ext:pet" ? "pet" : pageParam;
	const page: SettingsPage = SETTINGS_PAGE_IDS.includes(normalizedPageParam as SettingsPageId)
		? (normalizedPageParam as SettingsPageId)
		: normalizedPageParam?.startsWith(EXT_PAGE_PREFIX)
			? (normalizedPageParam as SettingsPage)
			: isSetupMode ? "provider" : "general";
	const [navSearch, setNavSearch] = useState("");
	const [restarting, setRestarting] = useState(false);
	const [restartError, setRestartError] = useState("");
	const handleConfigured = useCallback(async () => {
		// Prefer the sidecar-restart path (re-scans modelRegistry with the new key).
		// Fall back to "just go back to agent" if no restart callback was provided
		// (e.g. web/preview builds without Tauri).
		if (onRestartSidecar) {
			setRestarting(true);
			setRestartError("");
			try {
				await onRestartSidecar();
				navigate("/", { replace: true });
			} catch (e) {
				setRestartError(e instanceof Error ? e.message : String(e));
			} finally {
				setRestarting(false);
			}
		} else {
			navigate("/", { replace: true });
		}
	}, [onRestartSidecar, navigate]);

	// Track browser history position so we can enable/disable back/forward.
	// react-router v6 stores { idx, usr, key } on window.history.state.
	const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
	const maxIdxRef = useRef(histIdx);
	if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	// Reset the forward ceiling whenever location changes to a fresh entry.
	useEffect(() => {
		if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	}, [histIdx, location.key]);
	const canBack = histIdx > 0;
	const canForward = histIdx < maxIdxRef.current;

	// Extension-contributed menus surface as settings pages (`ext:<menuId>`) —
	// each registered menu becomes a nav entry whose items render as rows.
	const [extMenus, setExtMenus] = useState<ExtensionMenuWire[]>([]);
	const refreshExtMenus = useCallback(() => {
		void getExtensionMenus().then(setExtMenus).catch(() => {});
	}, []);
	useEffect(refreshExtMenus, [refreshExtMenus]);
	// Re-evaluate visible/getValue when an extension page is opened.
	useEffect(() => {
		if (page.startsWith(EXT_PAGE_PREFIX)) refreshExtMenus();
	}, [page, refreshExtMenus]);

	const navGroups: Array<{ label: string; items: Array<{ id: SettingsPage; icon: typeof Key; label: string }> }> = [
		{
			label: t("settings.tabs.general"),
			items: [
				{ id: "general", icon: SlidersHorizontal, label: t("settings.nav.general") },
				{ id: "pet", icon: PawPrint, label: t("settings.nav.pet") },
				{ id: "scheduler", icon: Clock, label: t("settings.nav.scheduler") },
				{ id: "about", icon: Info, label: t("settings.about.title") },
			],
		},
		{
			label: t("settings.nav.groupIntegrations"),
			items: [
				{ id: "provider", icon: Key, label: t("settings.tabs.provider") },
				{ id: "plugins", icon: Puzzle, label: t("layout.plugins") },
			],
		},
		...(extMenus.length > 0
			? [{
					label: t("settings.nav.groupExtensions"),
					items: extMenus.map((m) => ({
						id: `${EXT_PAGE_PREFIX}${m.id}` as SettingsPage,
						icon: Puzzle,
						label: m.label,
					})),
				}]
			: []),
	];
	// The search box filters nav entries (Codex settings pattern).
	const q = navSearch.trim().toLowerCase();
	const visibleGroups = navGroups
		.map((g) => ({ ...g, items: g.items.filter((i) => !q || i.label.toLowerCase().includes(q)) }))
		.filter((g) => g.items.length > 0);

	const activeExtMenu = page.startsWith(EXT_PAGE_PREFIX)
		? extMenus.find((m) => `${EXT_PAGE_PREFIX}${m.id}` === page)
		: undefined;

	const pageTitle =
		page === "general" ? t("settings.nav.general")
		: page === "pet" ? t("settings.nav.pet")
		: page === "scheduler" ? t("settings.nav.scheduler")
		: page === "about" ? t("settings.about.title")
		: page === "plugins" ? t("layout.plugins")
		: page === "provider" ? t("settings.tabs.provider")
		: (activeExtMenu?.label ?? t("settings.nav.groupExtensions"));

	return (
		<div className="flex h-full flex-col">
			{/* Top bar — sits next to the sidebar collapse button; holds back/forward nav */}
			<div
				data-tauri-drag-region="deep"
				className={cn(
					"flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface/80 pr-6 backdrop-blur transition-[padding] duration-150",
					macPad ? "pl-[76px]" : "pl-6",
				)}
			>
				<button
					data-no-drag
					data-tauri-drag-region="false"
					type="button"
					onClick={() => navigate(-1)}
					disabled={!canBack}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canBack ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.back")}
				>
					<ArrowLeft className="h-4 w-4" />
				</button>
				<button
					data-no-drag
					data-tauri-drag-region="false"
					type="button"
					onClick={() => navigate(1)}
					disabled={!canForward}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canForward ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.forward")}
				>
					<ArrowRight className="h-4 w-4" />
				</button>
			</div>

			<div className="flex min-h-0 flex-1">
				{/* Settings nav — Codex-style: back to app, search, grouped entries */}
				<aside className="w-60 shrink-0 overflow-y-auto border-r border-border/60 bg-surface px-2 py-3">
					<button
						type="button"
						onClick={() => navigate("/")}
						className="mb-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
					>
						<ArrowLeft className="h-4 w-4 shrink-0 text-muted" />
						{t("settings.nav.backToApp")}
					</button>
					<div className="relative mb-3 mt-1 px-0.5">
						<Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
						<input
							value={navSearch}
							onChange={(e) => setNavSearch(e.target.value)}
							placeholder={t("settings.nav.search")}
							className="h-8 w-full rounded-lg border border-border bg-bg pl-8 pr-2 text-xs text-fg outline-none placeholder:text-muted focus:border-muted"
						/>
					</div>
					{visibleGroups.map((group) => (
						<div key={group.label} className="mb-3">
							<div className="px-2.5 pb-1 text-[11px] font-medium text-muted">{group.label}</div>
							{group.items.map((item) => {
								const active = page === item.id;
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => {
											if (item.id === page) return;
											const next = new URLSearchParams(location.search);
											next.set("page", item.id);
											navigate({ pathname: "/settings", search: next.toString() });
										}}
										className={cn(
											"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
											active ? "bg-surface-2 font-medium text-fg" : "text-fg/80 hover:bg-surface-2/60",
										)}
										title={item.label}
									>
										<item.icon className={cn("h-4 w-4 shrink-0", active ? "text-fg" : "text-muted")} />
										<span className="truncate">{item.label}</span>
									</button>
								);
							})}
						</div>
					))}
				</aside>

				{/* Page content — centered column; the plugins page keeps the
				    wider card-grid layout it was designed for. */}
				<div data-settings-content className="scrollbar-hide min-h-0 flex-1 overflow-y-auto">
					<div className={cn("mx-auto px-10 pb-16 pt-8", page === "plugins" ? "max-w-5xl" : "max-w-4xl")}>
						<h1 className="mb-6 text-xl font-semibold tracking-tight text-fg">
							{isSetupMode && page === "provider" ? t("settings.setup.title") : pageTitle}
						</h1>

						{isSetupMode && page === "provider" && (
							<div className="mb-6">
								<SetupBanner state={state} />
								{restarting && (
									<p className="mt-2 text-xs text-muted">
										{t("settings.setup.restarting")}
									</p>
								)}
								{restartError && (
									<p className="mt-2 text-xs text-danger">{restartError}</p>
								)}
							</div>
						)}

						{page === "general" && <GeneralPage />}
						{page === "scheduler" && <SchedulerPage />}
						{page === "about" && <AboutPage />}
						{page === "provider" && isRemoteWorkspace ? (
							<Card>
								<div className="text-sm font-medium text-fg">
									{t("settings.provider.remoteManagedTitle")}
								</div>
								<p className="mt-2 text-xs leading-relaxed text-muted">
									{t("settings.provider.remoteManagedDescription")}
								</p>
							</Card>
						) : page === "provider" ? (
							<ProviderTab isSetupMode={isSetupMode} onConfigured={handleConfigured} />
						) : null}
						{page === "plugins" && <PluginsContent />}
						{page === "pet" && <PetSettingsPage workspace={workspace} />}
						{activeExtMenu && <ExtensionMenuPage menu={activeExtMenu} onAction={refreshExtMenus} />}
					</div>
				</div>
			</div>
		</div>
	);
}
