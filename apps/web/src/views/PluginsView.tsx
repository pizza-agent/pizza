import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card, Badge, Button, MoreMenu, type ContextMenuItem } from "@/components/ui";
import { confirmDialog } from "@/lib/confirm";
import { cn, pathBasename } from "@/lib/utils";
import {
	fetchSkillsSh,
	getSkills,
	setSkillEnabled,
	deleteSkill,
	getExtensions,
	setExtensionEnabled,
	installExtension,
	uninstallExtension,
	removePackage,
	getExtensionPermissions,
	recheckExtensionPermissions,
	openExtensionPermissionSettings,
	openExternal,
	type SkillsShSkill,
	type SkillInfo,
	type ExtensionInfo,
	type ExtensionPermissionKind,
	type ExtensionPermissionState,
} from "@/lib/transport";
import { Puzzle, BookOpen, Radio, Settings, Plus, Search, ExternalLink, Download, Power, Trash2, Hash, Send, Monitor, MousePointer2, RotateCw, ShieldCheck } from "lucide-react";
import { ChannelDialog } from "@/components/ChannelDialog";
import {
	listChannels,
	deleteChannel,
	setChannelEnabled,
	formatLastActivity,
	type ChannelInfo,
} from "@/lib/channels";

type PluginTab = "skills" | "extensions" | "channels";
const PERMISSION_CHECK_SLOW_MS = 6000;
const PERMISSION_OPEN_BUSY_MS = 3000;

interface TabConfig {
	key: PluginTab;
	icon: typeof BookOpen;
}

const TABS: TabConfig[] = [
	{ key: "skills", icon: BookOpen },
	{ key: "extensions", icon: Puzzle },
	{ key: "channels", icon: Radio },
];

function permissionFallbackState(
	extensionId: string,
	installed: boolean,
	message: string,
): ExtensionPermissionState {
	return {
		extensionId,
		supported: true,
		installed,
		ready: false,
		message,
		permissions: [],
	};
}

function InstalledSkillCard({
	skill,
	onToggle,
	onDelete,
	busyName,
}: {
	skill: SkillInfo;
	onToggle: (name: string, enabled: boolean) => void;
	onDelete: (name: string) => void;
	busyName: string | null;
}) {
	const { t } = useTranslation();
	const busy = busyName === skill.name;
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className={cn("min-w-0 flex-1 transition-opacity", !skill.enabled && "opacity-60")}>
					<div className="flex items-center gap-2">
					<BookOpen className={cn("h-4 w-4 shrink-0", skill.enabled ? "text-accent" : "text-muted")} />
						<span className="truncate text-sm font-medium text-fg">{skill.name}</span>
					</div>
					{skill.description && (
						<p className="mt-2 line-clamp-2 text-xs text-muted">{skill.description}</p>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{skill.enabled ? (
							<Badge tone="success">{t("plugins.skills.enabled")}</Badge>
						) : (
							<Badge tone="neutral">{t("plugins.skills.disabled")}</Badge>
						)}
						<Badge tone="neutral">{t(`plugins.skills.sources.${skill.builtin ? "builtin" : skill.source}`, skill.source)}</Badge>
						<code className="font-mono text-[10px] text-muted">{skill.command}</code>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<MoreMenu
						disabled={busy}
						title={t("plugins.skills.actions")}
						items={[
							{
								icon: Power,
								label: skill.enabled ? t("plugins.skills.disable") : t("plugins.skills.enable"),
								disabled: busy,
								onClick: () => onToggle(skill.name, !skill.enabled),
							},
							// Only user/project skills live as files the user authored;
							// built-in (registry) and package skills are not deletable here.
							...(!skill.builtin && (skill.source === "user" || skill.source === "project")
								? [
										{ divider: true as const },
										{
											icon: Trash2,
											label: t("plugins.skills.delete"),
											danger: true,
											disabled: busy,
											onClick: () => onDelete(skill.name),
										},
								  ]
								: []),
						]}
					/>
				</div>
			</div>
		</Card>
	);
}

function DirectorySkillCard({ skill, installed }: { skill: SkillsShSkill; installed: boolean }) {
	const { t } = useTranslation();
	const view = () => openExternal(skill.url);
	const install = () => openExternal(skill.installUrl ?? skill.url);
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<BookOpen className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{skill.name}</span>
					</div>
					<p className="mt-2 line-clamp-1 text-xs text-muted">{skill.source}</p>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{installed ? (
							<Badge tone="success">{t("plugins.skills.installed")}</Badge>
						) : (
							<Badge tone="accent">{t("plugins.skills.type")}</Badge>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<MoreMenu
						title={t("plugins.skills.actions")}
						items={[
							{ icon: ExternalLink, label: t("plugins.skills.view"), onClick: view },
							...(installed ? [] : [{ icon: Download, label: t("plugins.skills.install"), onClick: install }]),
						]}
					/>
				</div>
			</div>
		</Card>
	);
}

function SkillsTab() {
	const { t } = useTranslation();
	const [dirSkills, setDirSkills] = useState<SkillsShSkill[]>([]);
	const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [search, setSearch] = useState("");

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			// Load both in parallel — local skills may fail if sidecar is down
			const [dir, local] = await Promise.allSettled([
				fetchSkillsSh(),
				getSkills(),
			]);
			if (dir.status === "fulfilled") setDirSkills(dir.value);
			if (local.status === "fulfilled") setInstalledSkills(local.value);
			if (dir.status === "rejected" && local.status === "rejected") {
				setError(dir.reason instanceof Error ? dir.reason.message : String(dir.reason));
			}
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const [busyName, setBusyName] = useState<string | null>(null);
	const [reloadHint, setReloadHint] = useState(false);

	const handleToggle = useCallback(async (name: string, enabled: boolean) => {
		setBusyName(name);
		try {
			setReloadHint(await setSkillEnabled(name, enabled));
			setInstalledSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyName(null);
		}
	}, []);

	const handleDelete = useCallback(async (name: string) => {
		const ok = await confirmDialog({
			title: t("common.delete"),
			message: t("plugins.skills.deleteConfirm", { name }),
			confirmLabel: t("common.delete"),
			danger: true,
		});
		if (!ok) return;
		setBusyName(name);
		try {
			await deleteSkill(name);
			setInstalledSkills((prev) => prev.filter((s) => s.name !== name));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyName(null);
		}
	}, [t]);

	const installedNames = new Set(installedSkills.map((s) => s.name));
	const filteredDir = search.trim()
		? dirSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(search.toLowerCase()) ||
					s.source.toLowerCase().includes(search.toLowerCase()) ||
					s.slug.toLowerCase().includes(search.toLowerCase()),
			)
		: dirSkills;
	const filteredLocal = search.trim()
		? installedSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(search.toLowerCase()) ||
					s.description?.toLowerCase().includes(search.toLowerCase()),
			)
		: installedSkills;

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("plugins.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("plugins.error", { error })}</div>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("plugins.skills.search")}
						className="w-full rounded-md border border-border bg-surface px-9 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<Button size="sm" tone="neutral" onClick={refresh}>
					{t("plugins.refresh")}
				</Button>
			</div>

			{reloadHint && (
				<Card>
					<p className="text-xs text-muted">{t("plugins.skills.reloadHint")}</p>
				</Card>
			)}

			{filteredLocal.length > 0 && (
				<>
					<h2 className="mb-3 text-sm font-semibold text-fg">
						{t("plugins.skills.installedSection")} ({filteredLocal.length})
					</h2>
					<div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
						{filteredLocal.map((skill) => (
							<InstalledSkillCard
								key={skill.command}
								skill={skill}
								onToggle={handleToggle}
								onDelete={handleDelete}
								busyName={busyName}
							/>
						))}
					</div>
				</>
			)}

			<h2 className="mb-3 text-sm font-semibold text-fg">
				{t("plugins.skills.directorySection")} ({filteredDir.length})
			</h2>

			{filteredDir.length === 0 ? (
				<Card>
					<div className="py-6 text-center">
						<BookOpen className="mx-auto mb-2 h-8 w-8 text-muted/40" />
						<p className="font-mono text-xs text-muted">{t("plugins.skills.empty")}</p>
						<p className="mt-1 font-mono text-[10px] text-muted">{t("plugins.skills.emptyHint")}</p>
					</div>
				</Card>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{filteredDir.map((skill) => (
						<DirectorySkillCard
							key={skill.id}
							skill={skill}
							installed={installedNames.has(skill.slug)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ExtensionCard({
	ext,
	onToggle,
	onInstall,
	onUninstall,
	permissionState,
	permissionBusy,
	onOpenPermission,
	onRecheckPermissions,
	onRemovePackage,
	busyId,
}: {
	ext: ExtensionInfo;
	onToggle: (id: string, enabled: boolean) => void;
	onInstall: (id: string) => void;
	onUninstall: (id: string) => void;
	permissionState?: ExtensionPermissionState;
	permissionBusy: string | null;
	onOpenPermission: (id: string, kind: ExtensionPermissionKind) => void;
	onRecheckPermissions: (id: string) => void;
	onRemovePackage: (source: string) => void;
	busyId: string | null;
}) {
	const { t } = useTranslation();
	const kindLabel = t(`plugins.extensions.${ext.kind}`);
	const busy = busyId === ext.id;
	// An installable extension that hasn't had its external dependency installed
	// is not yet usable — only offer Install, and hide the enabled/disabled badge
	// and toggle to avoid implying the extension is operational.
	const notInstalledInstallable = ext.installable && !ext.installed;
	const showToggle = ext.canToggle && !notInstalledInstallable;
	const showEnabledBadge = !notInstalledInstallable;
	const showPermissionGuide = ext.id === "computer-use" && ext.installable && ext.installed;
	const menuItems: ContextMenuItem[] = [
		...(ext.installable
			? [{
					icon: ext.installed ? Trash2 : Download,
					label: busy
						? (ext.installed ? t("plugins.extensions.uninstalling") : t("plugins.extensions.installing"))
						: (ext.installed ? t("plugins.extensions.uninstall") : t("plugins.extensions.install")),
					disabled: busy,
					onClick: () => (ext.installed ? onUninstall(ext.id) : onInstall(ext.id)),
				}]
			: []),
		...(showToggle
			? [{
					icon: Power,
					label: ext.enabled ? t("plugins.extensions.disable") : t("plugins.extensions.enable"),
					disabled: busy,
					onClick: () => onToggle(ext.id, !ext.enabled),
				}]
			: []),
		// Resource packages (theme/skill/prompt packs) can only be removed, not toggled.
		...(ext.kind === "package"
			? [{
					icon: Trash2,
					label: busy ? t("plugins.extensions.uninstalling") : t("plugins.extensions.uninstall"),
					disabled: busy,
					onClick: () => onRemovePackage(ext.id),
				}]
			: []),
	];
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<Puzzle className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{ext.name}</span>
					</div>
					{ext.description && (
						<p className="mt-2 line-clamp-2 text-xs text-muted">{ext.description}</p>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{showEnabledBadge &&
							(ext.enabled ? (
								<Badge tone="success">{t("plugins.extensions.enabled")}</Badge>
							) : (
								<Badge tone="neutral">{t("plugins.extensions.disabled")}</Badge>
							))}
						<Badge tone="neutral">{kindLabel}</Badge>
						{ext.installable && (
							<Badge tone={ext.installed ? "success" : "warning"}>
								{ext.installed ? t("plugins.extensions.installed") : t("plugins.extensions.notInstalled")}
							</Badge>
						)}
						{(ext.toolCount > 0 || ext.kind === "builtin") && (
							<span className="text-[10px] text-muted">
								{t("plugins.extensions.tools", { count: ext.toolCount })}
							</span>
						)}
						{ext.commandCount > 0 && (
							<span className="text-[10px] text-muted">
								{t("plugins.extensions.commands", { count: ext.commandCount })}
							</span>
						)}
						{ext.builtinCommandCount > 0 && (
							<span className="text-[10px] text-muted">
								{t("plugins.extensions.cliCommands", { count: ext.builtinCommandCount })}
							</span>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{menuItems.length > 0 && (
						<MoreMenu
							disabled={busy}
							title={t("plugins.extensions.actions")}
							items={menuItems}
						/>
					)}
				</div>
			</div>
			{showPermissionGuide && (
				<ExtensionPermissionGuide
					extensionId={ext.id}
					state={permissionState}
					busy={permissionBusy}
					onOpen={(kind) => onOpenPermission(ext.id, kind)}
					onRecheck={() => onRecheckPermissions(ext.id)}
				/>
			)}
		</Card>
	);
}

function ExtensionPermissionGuide({
	extensionId,
	state,
	busy,
	onOpen,
	onRecheck,
}: {
	extensionId: string;
	state?: ExtensionPermissionState;
	busy: string | null;
	onOpen: (kind: ExtensionPermissionKind) => void;
	onRecheck: () => void;
}) {
	const { t } = useTranslation();
	const permissions = state?.permissions.length
		? state.permissions
		: [
				{ kind: "accessibility" as const, label: "Accessibility", description: "", granted: false, required: true },
				{ kind: "screenRecording" as const, label: "Screen Recording", description: "", granted: false, required: true },
			];
	const checking = !state;
	const ready = state?.ready === true;
	const missing = permissions.filter((permission) => permission.required && !permission.granted);
	const busyRecheck = busy === `${extensionId}:recheck`;

	return (
		<div className={cn(
			"mt-4 rounded-lg border px-3 py-3",
			ready ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5",
		)}>
			<div className="flex flex-col gap-2 @sm:flex-row @sm:items-center @sm:justify-between">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-xs font-medium text-fg">
						<ShieldCheck className={cn("h-3.5 w-3.5", ready ? "text-success" : "text-warning")} />
						<span>
							{checking
								? t("plugins.extensions.permissions.checking")
								: ready
									? t("plugins.extensions.permissions.ready")
									: t("plugins.extensions.permissions.needsSetup")}
						</span>
					</div>
					{state?.message && (
						<p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">{state.message}</p>
					)}
				</div>
				<Button
					size="sm"
					tone="neutral"
					variant="outline"
					iconLeft={<RotateCw className="h-3.5 w-3.5" />}
					loading={busyRecheck}
					disabled={busy !== null || checking}
					onClick={onRecheck}
				>
					{t("plugins.extensions.permissions.recheck")}
				</Button>
			</div>
			<div className="mt-3 space-y-2">
				{permissions.map((permission) => {
					const Icon = permission.kind === "screenRecording" ? Monitor : MousePointer2;
					const rowBusy = busy === `${extensionId}:${permission.kind}`;
					return (
						<div
							key={permission.kind}
							className="flex flex-col gap-2 rounded-md border border-border/70 bg-surface/70 px-3 py-2 @sm:flex-row @sm:items-center @sm:justify-between"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
									<span className="text-xs font-medium text-fg">
										{t(`plugins.extensions.permissions.${permission.kind}`)}
									</span>
									<Badge tone={permission.granted ? "success" : "warning"}>
										{checking
											? t("plugins.extensions.permissions.detecting")
											: permission.granted
											? t("plugins.extensions.permissions.granted")
											: t("plugins.extensions.permissions.missing")}
									</Badge>
								</div>
								<p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
									{t(`plugins.extensions.permissions.${permission.kind}Hint`)}
								</p>
							</div>
							{!checking && !permission.granted && (
								<Button
									size="sm"
									tone="accent"
									variant="soft"
									iconRight={<ExternalLink className="h-3.5 w-3.5" />}
									loading={rowBusy}
									disabled={busy !== null}
									onClick={() => onOpen(permission.kind)}
								>
									{t("plugins.extensions.permissions.openSettings")}
								</Button>
							)}
						</div>
					);
				})}
			</div>
			{!checking && missing.length > 0 && (
				<p className="mt-2 text-[11px] leading-relaxed text-muted">
					{t("plugins.extensions.permissions.afterOpen")}
				</p>
			)}
		</div>
	);
}

function ExtensionsTab() {
	const { t } = useTranslation();
	const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
	const [extensionPermissions, setExtensionPermissions] = useState<Record<string, ExtensionPermissionState>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [reloadHint, setReloadHint] = useState(false);
	const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
	const permissionRequestSeq = useRef(0);

	const refreshPermissions = useCallback(async (exts: ExtensionInfo[]) => {
		const permissionExts = exts.filter((ext) => ext.id === "computer-use" && ext.installable && ext.installed);
		if (permissionExts.length === 0) {
			setExtensionPermissions({});
			return;
		}
		const ids = new Set(permissionExts.map((ext) => ext.id));
		setExtensionPermissions((prev) => Object.fromEntries(
			Object.entries(prev).filter(([id]) => ids.has(id)),
		));
		for (const ext of permissionExts) {
			const requestId = ++permissionRequestSeq.current;
			let settled = false;
			const timeout = window.setTimeout(() => {
				if (settled || permissionRequestSeq.current !== requestId) return;
				setExtensionPermissions((prev) => ({
					...prev,
					[ext.id]: permissionFallbackState(
						ext.id,
						ext.installed,
						t("plugins.extensions.permissions.checkSlow"),
					),
				}));
			}, PERMISSION_CHECK_SLOW_MS);
			void getExtensionPermissions(ext.id)
				.then((result) => {
					settled = true;
					window.clearTimeout(timeout);
					if (permissionRequestSeq.current !== requestId) return;
					setExtensionPermissions((prev) => ({ ...prev, [ext.id]: result }));
				})
				.catch((e) => {
					settled = true;
					window.clearTimeout(timeout);
					if (permissionRequestSeq.current !== requestId) return;
					setExtensionPermissions((prev) => ({
						...prev,
						[ext.id]: permissionFallbackState(
							ext.id,
							ext.installed,
							e instanceof Error ? e.message : String(e),
						),
					}));
				});
		}
	}, [t]);

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			const exts = await getExtensions();
			setExtensions(exts);
			setLoading(false);
			void refreshPermissions(exts);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setLoading(false);
		}
	}, [refreshPermissions]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleToggle = useCallback(
		async (id: string, enabled: boolean) => {
			const requiresReload = await setExtensionEnabled(id, enabled);
			setReloadHint(requiresReload);
			// Optimistically flip the local state; a full refresh re-syncs with the agent.
			setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, enabled } : e)));
		},
		[],
	);

	const [busyId, setBusyId] = useState<string | null>(null);
	const [installMessage, setInstallMessage] = useState<string | null>(null);
	// Synchronous guard so rapid double-clicks can't bypass the busyId state update.
	const lifecycleLock = useRef<string | null>(null);

	const runLifecycle = useCallback(
		async (id: string, fn: (id: string) => Promise<{ ok: boolean; message: string; installed: boolean }>) => {
			if (lifecycleLock.current) return;
			lifecycleLock.current = id;
			setBusyId(id);
			setInstallMessage(null);
			try {
				const result = await fn(id);
				setInstallMessage(result.message);
				if (result.ok) {
					// Re-sync with the agent: install/uninstall may change tool/command counts,
					// enabled state, or other fields beyond just `installed`.
					await refresh();
				} else {
					// On failure, only update the install flag locally.
					setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, installed: result.installed } : e)));
				}
			} catch (e) {
				setInstallMessage(e instanceof Error ? e.message : String(e));
			} finally {
				lifecycleLock.current = null;
				setBusyId(null);
			}
		},
		[refresh],
	);

	const handleInstall = useCallback((id: string) => runLifecycle(id, installExtension), [runLifecycle]);
	const handleUninstall = useCallback((id: string) => runLifecycle(id, uninstallExtension), [runLifecycle]);

	const handleRemovePackage = useCallback(
		async (source: string) => {
			const ok = await confirmDialog({
				title: t("plugins.extensions.uninstall"),
				message: t("plugins.extensions.removePackageConfirm", { name: source }),
				confirmLabel: t("common.remove"),
				danger: true,
			});
			if (!ok) return;
			setBusyId(source);
			setInstallMessage(null);
			try {
				const result = await removePackage(source);
				if (result.removed) {
					setReloadHint(result.requiresReload);
					setExtensions((prev) => prev.filter((e) => e.id !== source));
				} else {
					setInstallMessage(result.error ?? t("plugins.extensions.removePackageFailed"));
				}
			} catch (e) {
				setInstallMessage(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[t],
	);

	const handleOpenPermission = useCallback(async (id: string, kind: ExtensionPermissionKind) => {
		if (permissionBusy) return;
		setPermissionBusy(`${id}:${kind}`);
		const busyTimeout = window.setTimeout(() => setPermissionBusy(null), PERMISSION_OPEN_BUSY_MS);
		try {
			const result = await openExtensionPermissionSettings(id, kind);
			if (!result.ok && result.message) setInstallMessage(result.message);
		} catch (e) {
			setInstallMessage(e instanceof Error ? e.message : String(e));
		} finally {
			window.clearTimeout(busyTimeout);
			setPermissionBusy(null);
		}
	}, [permissionBusy]);

	const handleRecheckPermissions = useCallback(async (id: string) => {
		if (permissionBusy) return;
		setPermissionBusy(`${id}:recheck`);
		const requestId = ++permissionRequestSeq.current;
		let settled = false;
		const ext = extensions.find((item) => item.id === id);
		setExtensionPermissions((prev) => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
		const timeout = window.setTimeout(() => {
			if (settled || permissionRequestSeq.current !== requestId) return;
			setExtensionPermissions((prev) => ({
				...prev,
				[id]: permissionFallbackState(
					id,
					ext?.installed ?? true,
					t("plugins.extensions.permissions.checkSlow"),
				),
			}));
			setPermissionBusy(null);
		}, PERMISSION_CHECK_SLOW_MS);
		try {
			const result = await recheckExtensionPermissions(id);
			settled = true;
			window.clearTimeout(timeout);
			if (permissionRequestSeq.current !== requestId) return;
			setExtensionPermissions((prev) => ({ ...prev, [id]: result }));
			setInstallMessage(result.ready
				? t("plugins.extensions.permissions.ready")
				: t("plugins.extensions.permissions.stillMissing"));
		} catch (e) {
			settled = true;
			window.clearTimeout(timeout);
			if (permissionRequestSeq.current !== requestId) return;
			setInstallMessage(e instanceof Error ? e.message : String(e));
			setExtensionPermissions((prev) => ({
				...prev,
				[id]: permissionFallbackState(
					id,
					ext?.installed ?? true,
					e instanceof Error ? e.message : String(e),
				),
			}));
		} finally {
			if (permissionRequestSeq.current === requestId) setPermissionBusy(null);
		}
	}, [extensions, permissionBusy, t]);

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("plugins.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("plugins.error", { error })}</div>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-end">
				<Button size="sm" tone="neutral" onClick={refresh}>
					{t("plugins.refresh")}
				</Button>
			</div>

			{reloadHint && (
				<Card>
					<p className="text-xs text-muted">{t("plugins.extensions.reloadHint")}</p>
				</Card>
			)}
			{installMessage && (
				<Card>
					<p className="text-xs text-muted">{installMessage}</p>
				</Card>
			)}

			{extensions.length === 0 ? (
				<Card>
					<div className="py-6 text-center">
						<Puzzle className="mx-auto mb-2 h-8 w-8 text-muted/40" />
						<p className="font-mono text-xs text-muted">{t("plugins.extensions.empty")}</p>
					</div>
				</Card>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{extensions.map((ext) => (
						<ExtensionCard
							key={ext.id}
							ext={ext}
							onToggle={handleToggle}
							onInstall={handleInstall}
							onUninstall={handleUninstall}
							permissionState={extensionPermissions[ext.id]}
							permissionBusy={permissionBusy}
							onOpenPermission={handleOpenPermission}
							onRecheckPermissions={handleRecheckPermissions}
							onRemovePackage={handleRemovePackage}
							busyId={busyId}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** Per-type icon + accent tint for the channel card header. */
function channelIcon(type: ChannelInfo["type"]) {
	switch (type) {
		case "discord":
		case "slack":
			return Hash;
		case "telegram":
			return Send;
		case "webhook":
			return Radio;
		case "lark":
		default:
			return BookOpen;
	}
}

function ChannelCard({
	channel,
	onToggle,
	onConfigure,
	onDelete,
	busyId,
}: {
	channel: ChannelInfo;
	onToggle: (id: string, enabled: boolean) => void;
	onConfigure: (ch: ChannelInfo) => void;
	onDelete: (id: string) => void;
	busyId: string | null;
}) {
	const { t } = useTranslation();
	const Icon = channelIcon(channel.type);
	const busy = busyId === channel.id;
	const statusTone =
		channel.status === "connected" ? "success" : channel.status === "error" ? "danger" : "neutral";
	const statusKey = channel.enabled ? channel.status : "disconnected";
	const wsName = channel.workspace ? pathBasename(channel.workspace) : "";
	return (
		<Card className="@container transition-colors hover:border-accent/40">
			<div className="flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<Icon className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{channel.name}</span>
						<code className="font-mono text-[10px] text-muted">{t(`channels.types.${channel.type}`)}</code>
					</div>
					{(channel.server || channel.channel) && (
						<p className="mt-1.5 truncate font-mono text-xs text-muted">
							{[channel.server, channel.channel].filter(Boolean).join(" / ")}
						</p>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Badge tone={statusTone}>{t(`channels.status.${statusKey}`)}</Badge>
						{wsName ? (
							<Badge tone="neutral">{t("channels.bind", { workspace: wsName })}</Badge>
						) : (
							<Badge tone="warning">{t("channels.bindNone")}</Badge>
						)}
						<span className="text-[10px] text-muted">
							{formatLastActivity(channel.lastMessageAt, {
								ago: (s) => t("channels.recent", { time: s }),
								never: t("channels.recentNever"),
							})}
						</span>
						{channel.lastError && channel.status === "error" && (
							<span className="text-[10px] text-danger">{channel.lastError}</span>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<MoreMenu
						disabled={busy}
						title={t("channels.actions")}
						items={[
							{
								icon: Power,
								label: channel.enabled ? t("channels.disable") : t("channels.enable"),
								disabled: busy,
								onClick: () => onToggle(channel.id, !channel.enabled),
							},
							{
								icon: Settings,
								label: t("channels.configure"),
								disabled: busy,
								onClick: () => onConfigure(channel),
							},
							{ divider: true },
							{
								icon: Trash2,
								label: t("channels.delete"),
								danger: true,
								disabled: busy,
								onClick: () => onDelete(channel.id),
							},
						]}
					/>
				</div>
			</div>
		</Card>
	);
}

function ChannelsTab() {
	const { t } = useTranslation();
	const [channels, setChannels] = useState<ChannelInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ChannelInfo | null>(null);

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			setChannels(await listChannels());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const upsert = useCallback((ch: ChannelInfo) => {
		setChannels((prev) => {
			const idx = prev.findIndex((c) => c.id === ch.id);
			if (idx === -1) return [...prev, ch];
			const next = [...prev];
			next[idx] = ch;
			return next;
		});
	}, []);

	const handleToggle = useCallback(
		async (id: string, enabled: boolean) => {
			setBusyId(id);
			try {
				const updated = await setChannelEnabled(id, enabled);
				upsert(updated);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[upsert],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			const ch = channels.find((c) => c.id === id);
			if (!ch) return;
			const ok = await confirmDialog({
				title: t("common.delete"),
				message: t("channels.confirmDelete", { name: ch.name }),
				confirmLabel: t("common.delete"),
				danger: true,
			});
			if (!ok) return;
			setBusyId(id);
			try {
				await deleteChannel(id);
				setChannels((prev) => prev.filter((c) => c.id !== id));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[channels, t],
	);

	const handleConfigure = useCallback((ch: ChannelInfo) => {
		setEditing(ch);
		setDialogOpen(true);
	}, []);

	const handleAdd = useCallback(() => {
		setEditing(null);
		setDialogOpen(true);
	}, []);

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("channels.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("channels.error", { error })}</div>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<ChannelDialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				existing={editing}
				onSaved={upsert}
			/>
			<div className="flex items-center justify-end">
				<Button size="sm" tone="accent" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={handleAdd}>
					{t("channels.add")}
				</Button>
			</div>

			{channels.length === 0 ? (
				<Card>
					<div className="py-6 text-center">
						<Radio className="mx-auto mb-2 h-8 w-8 text-muted/40" />
						<p className="font-mono text-xs text-muted">{t("channels.empty")}</p>
						<p className="mt-1 font-mono text-[10px] text-muted">{t("channels.emptyHint")}</p>
					</div>
				</Card>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{channels.map((ch) => (
						<ChannelCard
							key={ch.id}
							channel={ch}
							onToggle={handleToggle}
							onConfigure={handleConfigure}
							onDelete={handleDelete}
							busyId={busyId}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// Plugins page content — rendered inside the Settings shell (left nav +
// page title) at /settings?page=plugins. Own chrome lives in SettingsView.
export function PluginsContent() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<PluginTab>("skills");

	return (
		<>
			<p className="-mt-2 mb-6 text-sm text-muted">{t("plugins.description")}</p>

			<div className="mb-6 flex gap-1 border-b border-border">
				{TABS.map(({ key, icon: Icon }) => (
					<button
						key={key}
						onClick={() => setTab(key)}
						className={cn(
							"flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
							tab === key
								? "border-b-2 border-accent text-accent"
								: "text-muted hover:text-fg",
						)}
					>
						<Icon className="h-3.5 w-3.5" />
						{t(`plugins.tabs.${key}`)}
					</button>
				))}
			</div>

			{tab === "skills" && <SkillsTab />}
			{tab === "extensions" && <ExtensionsTab />}
			{tab === "channels" && <ChannelsTab />}
		</>
	);
}
