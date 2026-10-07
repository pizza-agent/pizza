import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Settings as SettingsIcon, Plus, Folder, MessageSquare, MoreHorizontal, Pin, FolderOpen, Trash2, PanelLeft, Puzzle } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StatusDot, ThemeToggle, Button, MoreMenu, type ContextMenuItem } from "./ui";
import { confirmDialog, alertDialog } from "@/lib/confirm";
import { BrandIcon } from "./BrandIcon";
import WorkspacePane from "./WorkspacePane";
import { UpdateBanner } from "./UpdateBanner";
import { cn, isTauri, hasMacTrafficLights, isMainChatCwd, samePath, MAIN_CHAT_CWD, pathBasename } from "@/lib/utils";
import { deleteWorkspace, revealWorkspace } from "@/lib/transport";
import { clearComposerDraft } from "@/lib/composer-drafts";
import { Z } from "@/lib/z-index";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

const PINNED_KEY = "pizza:pinned-workspaces";
const COLLAPSED_KEY = "pizza:sidebar-collapsed";

/** Context passed to routed views so their top header can clear the macOS traffic lights + toggle when the sidebar is collapsed. */
export type LayoutOutletContext = { sidebarCollapsed: boolean };

function getPinnedWorkspaces(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		if (raw) return new Set(JSON.parse(raw) as string[]);
	} catch { /* ignore */ }
	return new Set();
}

function setPinnedWorkspaces(ids: Set<string>): void {
	try {
		localStorage.setItem(PINNED_KEY, JSON.stringify([...ids]));
	} catch { /* ignore */ }
}

function basename(path: string): string {
	return pathBasename(path);
}

function timeAgo(ts: number, t: TFunction): string {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60000);
	if (min < 1) return t("layout.timeJustNow");
	if (min < 60) return t("layout.timeMinutesAgo", { count: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("layout.timeHoursAgo", { count: hr });
	const days = Math.floor(hr / 24);
	return t("layout.timeDaysAgo", { count: days });
}

/** True when a `_cwd`-keyed streaming set contains `path` (separator-insensitive). */
function setHasPath(set: Set<string> | undefined, path: string): boolean {
	if (!set) return false;
	for (const p of set) if (samePath(p, path)) return true;
	return false;
}

export default function Layout({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	workspaces,
	onSelectWorkspace,
	onNewWorkspace,
	onDeleteWorkspace,
	streamingCwds,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	workspaces?: WorkspaceMeta[];
	onSelectWorkspace?: (cwd: string) => void;
	onNewWorkspace?: () => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	streamingCwds?: Set<string>;
}) {
	const { t } = useTranslation();
	// Settings takes over the whole window (Codex-style): the app sidebar and
	// docks are hidden and the settings view provides its own "back to app".
	const location = useLocation();
	const isSettingsRoute = location.pathname.startsWith("/settings");
	const isPluginsActive =
		location.pathname === "/settings" &&
		new URLSearchParams(location.search).get("page") === "plugins";
	// macOS overlay title bar needs left padding so the collapse/expand
	// buttons clear the traffic lights; other platforms have a normal title
	// bar and need no reserved space. Evaluated once — platform never changes.
	const macPad = hasMacTrafficLights();
	// Re-render every 30s so the "x min ago" workspace timestamps stay fresh.
	const [, setClockTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setClockTick((n) => n + 1), 30_000);
		return () => clearInterval(id);
	}, []);
	const online = sidecarReady && sidecarExitCode === null;
	const isMainChat = isMainChatCwd(workspace);
	const [pinned, setPinned] = useState<Set<string>>(getPinnedWorkspaces);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<boolean>(() => {
		try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
	});
	const [hovered, setHovered] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
			return next;
		});
	}, []);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
	}, []);
	useEffect(() => clearHoverTimer, [clearHoverTimer]);

	const showSidebar = !collapsed || hovered;
	const floating = collapsed && hovered;

	const togglePin = useCallback((ws: WorkspaceMeta) => {
		setPinned((prev) => {
			const next = new Set(prev);
			if (next.has(ws.workspace_id)) {
				next.delete(ws.workspace_id);
			} else {
				next.add(ws.workspace_id);
			}
			setPinnedWorkspaces(next);
			return next;
		});
	}, []);

	const handleDelete = useCallback(async (ws: WorkspaceMeta) => {
		const name = basename(ws.cwd);
		const stale = ws.dir_exists === false;
		const ok = await confirmDialog({
			title: t("common.delete"),
			message: stale
				? t("layout.deleteStaleWorkspaceConfirm", { name, cwd: ws.cwd })
				: t("layout.deleteWorkspaceConfirm", { name }),
			confirmLabel: t("common.delete"),
			danger: true,
		});
		if (!ok) return;
		try {
			await deleteWorkspace(ws.workspace_id);
			clearComposerDraft(ws.cwd);
			onDeleteWorkspace?.(ws.workspace_id);
		} catch (e) {
			console.error("[workspace] delete error:", e);
			void alertDialog({ title: t("common.error"), message: t("layout.deleteWorkspaceFailed", { error: e instanceof Error ? e.message : String(e) }), danger: true });
		}
	}, [onDeleteWorkspace, t]);

	/** Menu entries for a workspace row — rendered by the shared MoreMenu
	 *  (viewport clamping, Escape and outside-click dismissal built in). */
	const workspaceMenuItems = useCallback((ws: WorkspaceMeta, isPinned: boolean): ContextMenuItem[] => [
		{
			icon: Pin,
			label: isPinned ? t("layout.unpin") : t("layout.pinToTop"),
			onClick: () => togglePin(ws),
		},
		{
			icon: FolderOpen,
			label: t("layout.revealInFiles"),
			onClick: () => void revealWorkspace(ws.cwd),
		},
		{ divider: true },
		{
			icon: Trash2,
			label: t("common.delete"),
			danger: true,
			onClick: () => void handleDelete(ws),
		},
	], [t, togglePin, handleDelete]);

	const sortedWorkspaces = workspaces
		? [...workspaces].sort((a, b) => {
			const aPinned = pinned.has(a.workspace_id);
			const bPinned = pinned.has(b.workspace_id);
			if (aPinned !== bPinned) return aPinned ? -1 : 1;
			return b.last_accessed_at - a.last_accessed_at;
		})
		: [];

	return (
		<div className="relative flex h-full bg-bg">
			{/* Expand button — shown only while collapsed, sits in the title bar just right of the macOS traffic lights */}
			{!isSettingsRoute && !showSidebar && (
				<button
					onClick={toggleCollapsed}
					className={cn(
						"fixed top-[6px] flex h-8 w-8 items-center justify-center rounded-lg text-muted/50 transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-2",
						Z.chrome,
						macPad ? "left-[76px]" : "left-2",
					)}
					title={t("layout.showSidebar")}
				>
					<PanelLeft className="h-4 w-4" />
				</button>
			)}

			{/* Left-edge hover strip: reveals the sidebar as a floating overlay while
			    collapsed — but only after the cursor dwells on the edge (~1s), so a
			    passing swipe does not pop the menu open. */}
			{!isSettingsRoute && collapsed && (
				<div
					className={cn("fixed inset-y-0 left-0 w-2", Z.overlay)}
					onMouseEnter={() => {
						clearHoverTimer();
						hoverTimerRef.current = setTimeout(() => setHovered(true), 500);
					}}
					onMouseLeave={() => clearHoverTimer()}
				/>
			)}
			<aside
				onMouseEnter={() => { clearHoverTimer(); if (collapsed) setHovered(true); }}
				onMouseLeave={() => { if (collapsed) { clearHoverTimer(); hoverTimerRef.current = setTimeout(() => setHovered(false), 150); } }}
				className={cn(
					"flex w-64 flex-col border-r border-border bg-surface transition-all duration-150",
					floating ? cn("absolute inset-y-0 left-0 shadow-2xl", Z.chrome) : "",
					!showSidebar ? "pointer-events-none w-0 -translate-x-full overflow-hidden opacity-0" : "",
					isSettingsRoute && "hidden",
				)}
			>
				{/* Top bar — aligns with the macOS traffic lights; holds the collapse button */}
				<div
					data-tauri-drag-region="deep"
					className={cn("flex h-11 shrink-0 items-center pr-2", macPad ? "pl-[76px]" : "pl-2")}
				>
					<button
						data-no-drag
						data-tauri-drag-region="false"
						onClick={toggleCollapsed}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted/50 transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-2"
						title={t("layout.hideSidebar")}
					>
						<PanelLeft className="h-4 w-4" />
					</button>
				</div>
				<div
					data-tauri-drag-region="deep"
					className="flex items-center gap-3 px-5 pb-2 pt-1"
				>
					<BrandIcon size={26} className="shrink-0 text-fg" />
					<div className="leading-tight">
						<div className="text-[15px] font-semibold tracking-tight text-fg">
							Pizza
						</div>
						<div className="text-[11px] text-muted">
							{t("layout.brandTagline")}
						</div>
					</div>
				</div>
				{/* Main agent — persistent */}
				<div className="px-3 pt-2 pb-1">
					<button
						onClick={() => onSelectWorkspace?.(MAIN_CHAT_CWD)}
						className={cn(
							"flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
							isMainChat
								? "bg-surface-2"
								: "hover:bg-surface-2/60",
						)}
						title={t("layout.agentTitle")}
					>
						<MessageSquare
							className={cn(
								"h-4 w-4 shrink-0",
								isMainChat ? "text-accent" : "text-muted",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div
								className={cn(
									"truncate text-[13px] font-medium",
									isMainChat ? "text-fg" : "text-fg/90",
								)}
							>
								{t("layout.agent")}
							</div>
							<div className="truncate text-[11px] text-muted">
								{t("layout.agentSubtitle")}
							</div>
						</div>
						{isMainChat && online && (
							<span
								className={cn(
									"h-1.5 w-1.5 shrink-0 rounded-full",
									state?.isStreaming || (streamingCwds && [...streamingCwds].some(isMainChatCwd)) ? "bg-accent animate-pulse" : "bg-success",
								)}
							/>
						)}
					</button>
				</div>

				{/* Workspaces section */}
				<div className="flex-1 overflow-y-auto px-3 py-2">
					<div className="mb-1 flex items-center justify-between px-2">
						<span className="text-[11px] font-medium text-muted">
							{t("layout.workspaces")}
						</span>
						{isTauri() && (
							<button
								onClick={() => onNewWorkspace?.()}
								className="text-muted transition-colors hover:text-fg"
								title={t("layout.newWorkspaceTitle")}
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
					{sortedWorkspaces.length > 0 ? (
						<div className="space-y-0.5">
							{sortedWorkspaces.map((ws) => {
								const isActive = samePath(workspace, ws.cwd);
								const isPinned = pinned.has(ws.workspace_id);
								const isMenuOpen = menuOpenId === ws.workspace_id;
								return (
									<div key={ws.workspace_id} className="group relative">
										<div
											onClick={() => {
												// Stale entry (project directory removed externally):
												// switching would only produce init_sidecar's
												// "Directory does not exist" error — offer removal
												// instead of a doomed switch.
												if (ws.dir_exists === false) {
													void handleDelete(ws);
													return;
												}
												onSelectWorkspace?.(ws.cwd);
											}}
											className={cn(
												"flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
												isActive
													? "bg-surface-2"
													: "hover:bg-surface-2/60",
												ws.dir_exists === false && "opacity-60",
											)}
											title={ws.dir_exists === false ? t("layout.staleWorkspaceTitle", { cwd: ws.cwd }) : ws.cwd}
										>
											{isPinned ? (
												<Pin className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} />
											) : (
												<Folder className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} />
											)}
											<div className="min-w-0 flex-1">
												<div
													className={cn(
														"truncate text-[13px]",
														isActive ? "font-medium text-fg" : "text-fg/90",
													)}
												>
													{basename(ws.cwd)}
													{ws.dir_exists === false && (
														<span className="ml-1 text-[10px] font-medium text-warning">{t("layout.staleWorkspaceBadge")}</span>
													)}
												</div>
												<div className="truncate text-[11px] text-muted">
													{timeAgo(ws.last_accessed_at, t)}
												</div>
											</div>
											{online && (isActive || setHasPath(streamingCwds, ws.cwd)) && (
												<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", (isActive ? state?.isStreaming : true) ? "bg-accent animate-pulse" : "bg-success")} />
											)}
											<MoreMenu
												title={t("layout.moreActions")}
												icon={<MoreHorizontal className="h-3.5 w-3.5" />}
												triggerClassName={cn(
													"ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:text-fg hover:bg-surface-2 group-hover:opacity-100",
													isMenuOpen ? "opacity-100" : "opacity-0",
												)}
												open={isMenuOpen}
												onOpenChange={(open) => setMenuOpenId(open ? ws.workspace_id : null)}
												items={workspaceMenuItems(ws, isPinned)}
											/>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<div className="px-2 py-4 text-center">
							<p className="text-xs text-muted">{t("layout.noWorkspaces")}</p>
						</div>
					)}
				</div>

				{isTauri() && (
					<div className="mb-2 px-1">
						<Button tone="neutral" size="sm" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => onNewWorkspace?.()} className="w-full">{t("layout.newWorkspace")}</Button>
					</div>
				)}

				{/* Plugins nav */}
				<div className="border-t border-border px-3 pt-2 pb-1">
					<NavLink
						to="/settings?page=plugins"
						className={({ isActive }) => cn(
							"flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
							isActive
								? "bg-surface-2"
								: "hover:bg-surface-2/60",
						)}
						title={t("plugins.title")}
					>
						<Puzzle className={cn("h-4 w-4 shrink-0", isPluginsActive ? "text-accent" : "text-muted")} />
						<div className="min-w-0 flex-1">
							<div className={cn("truncate text-[13px]", isPluginsActive ? "font-medium text-fg" : "font-medium text-fg/90")}>
								{t("layout.plugins")}
							</div>
							<div className="truncate text-[11px] text-muted">
								{t("layout.pluginsSubtitle")}
							</div>
						</div>
					</NavLink>
				</div>

				<div className="border-t border-border px-3 py-3">

					<div className="flex items-center justify-between rounded-md px-2 py-1.5">
						<div className="flex items-center gap-2 text-xs">
							{online && state?.isStreaming ? (
								<span className="h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse" />
							) : (
								<StatusDot tone={online ? "success" : "danger"} />
							)}
							<span className="text-muted">
								{online ? (state?.isStreaming ? t("layout.statusRunning") : t("layout.statusOnline")) : t("layout.statusOffline")}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<NavLink to="/settings" className={({ isActive }) => cn("flex items-center justify-center rounded-md p-1.5 transition-colors", isActive ? "text-accent" : "text-muted hover:text-fg")} title={t("common.settings")}><SettingsIcon className="h-4 w-4" /></NavLink>
							<ThemeToggle />
						</div>
					</div>
				</div>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<UpdateBanner />
				<div className="min-h-0 flex-1">
				{isSettingsRoute ? (
					/* Full-bleed settings: no right/bottom docks, top bar clears the
					   traffic lights itself (sidebarCollapsed=true in the context). */
					<Outlet context={{ sidebarCollapsed: true } satisfies LayoutOutletContext} />
				) : (
					<WorkspacePane workspace={workspace} ptyPort={state?.ptyPort}>
						<Outlet context={{ sidebarCollapsed: collapsed } satisfies LayoutOutletContext} />
					</WorkspacePane>
				)}
				</div>
			</main>
		</div>
	);
}
