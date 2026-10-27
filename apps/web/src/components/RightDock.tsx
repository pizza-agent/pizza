import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Activity, FolderTree, GitCommitHorizontal, Globe, Bot } from "lucide-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import { gitStatus } from "@/lib/transport";
import BranchTreeExplorer from "@/views/BranchTreeExplorer";
import EventTimeline from "@/views/EventTimeline";
import FileExplorer from "@/views/FileExplorer";
import GitStatusView from "@/views/GitStatusView";
import MainAgentView from "@/views/MainAgentView";
import type { MainAgentProfileState } from "@/lib/main-agent-profile";
import BrowserPane from "./browser/BrowserPane";

export type RightDockTab = "agent" | "git" | "files" | "history" | "timeline" | "browser";

/**
 * The right-hand dock hosting the Git (status/diff), Files, History (branch
 * tree) and Timeline (event stream) tabs. The Git tab is only shown when the
 * active workspace is a git repository. Scoped to the active workspace — its
 * children refetch/reset when `workspace` changes.
 */
export default function RightDock({ workspace, isMain = false, selectedTab, onTabChange, mainAgent, running = false, connected = false, headerAction }: {
	workspace?: string | null;
	isMain?: boolean;
	selectedTab?: RightDockTab;
	onTabChange?: (tab: RightDockTab) => void;
	mainAgent?: MainAgentProfileState;
	running?: boolean;
	connected?: boolean;
	headerAction?: ReactNode;
}) {
	const { t } = useTranslation();
	const [savedTab, setSavedTab] = usePersistedState<RightDockTab>("right-dock-tab", "files");
	const tab = selectedTab ?? savedTab;
	const setTab = onTabChange ?? setSavedTab;
	const [isGitRepo, setIsGitRepo] = useState(false);

	// Detect whether the current workspace is a git repo so we can show/hide
	// the Git tab. Best-effort: failures default to "not a repo".
	useEffect(() => {
		let cancelled = false;
		if (!workspace) {
			setIsGitRepo(false);
			return;
		}
		void gitStatus(workspace)
			.then((s) => { if (!cancelled) setIsGitRepo(s.is_repo); })
			.catch(() => { if (!cancelled) setIsGitRepo(false); });
		return () => { cancelled = true; };
	}, [workspace]);

	// If the persisted tab is "git" but the workspace is not a repo, fall back
	// to "files" so the dock never shows an empty pane.
	const activeTab: RightDockTab = (tab === "git" && !isGitRepo) || (tab === "agent" && !isMain) ? "files" : tab;

	const tabs: Array<{ id: RightDockTab; label: string; icon: typeof GitBranch }> = [
		...(isMain ? [{ id: "agent" as const, label: t("layout.agent"), icon: Bot }] : []),
		{ id: "history", label: t("history.title"), icon: GitBranch },
		...(isGitRepo ? [{ id: "git" as const, label: t("git.title"), icon: GitCommitHorizontal }] : []),
		{ id: "files", label: t("files.title"), icon: FolderTree },
		{ id: "timeline", label: t("timeline.title"), icon: Activity },
		{ id: "browser", label: t("browser.title"), icon: Globe },
	];

	return (
		<div className="flex h-full flex-col bg-surface">
			{/* The action has its own fixed slot; scrolling tabs never cover it.
			    Compact panels keep the selected label and all other tool icons. */}
			<div data-right-dock-header className="@container/dock relative flex h-11 shrink-0 items-center after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border/50">
			<div role="tablist" aria-label={t("dock.toggleRight")} onKeyDown={(event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"));
				const current = buttons.indexOf(event.target as HTMLButtonElement);
				const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
				buttons[next]?.click(); buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
			}} className="scrollbar-hide flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5">
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						role="tab"
						aria-selected={activeTab === id}
						tabIndex={activeTab === id ? 0 : -1}
						aria-controls="right-dock-content"
						aria-label={label}
						onClick={(event) => {
							setTab(id);
							const button = event.currentTarget;
							requestAnimationFrame(() => button.scrollIntoView({ block: "nearest", inline: "nearest" }));
						}}
						className={cn(
							"flex max-w-44 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors @min-[560px]/dock:px-2.5",
							activeTab === id
								? "bg-surface-2 px-2.5 text-accent"
								: "text-muted hover:bg-surface-2/60 hover:text-fg",
						)}
						title={label}
					>
						<Icon className="h-3.5 w-3.5 shrink-0" />
						<span className={cn("truncate", activeTab !== id && "hidden @min-[560px]/dock:inline")}>{label}</span>
					</button>
				))}
			</div>
			{headerAction && <div className="flex h-full shrink-0 items-start gap-1 pl-2 pr-2 pt-2">{headerAction}</div>}
			</div>
			<div id="right-dock-content" role="tabpanel" aria-label={tabs.find((item) => item.id === activeTab)?.label} className="min-h-0 flex-1">
				{activeTab === "agent" && isMain && mainAgent && workspace ? (
					<MainAgentView key={workspace} workspace={workspace} data={mainAgent} running={running} connected={connected} />
				) : activeTab === "git" ? (
					<GitStatusView workspace={workspace} />
				) : activeTab === "files" ? (
					<FileExplorer workspace={workspace} />
				) : activeTab === "history" ? (
					<BranchTreeExplorer workspace={workspace} />
				) : activeTab === "browser" ? (
					<BrowserPane workspace={workspace} />
				) : (
					<EventTimeline workspace={workspace} />
				)}
			</div>
		</div>
	);
}
