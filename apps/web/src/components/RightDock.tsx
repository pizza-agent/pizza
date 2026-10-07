import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Activity, FolderTree, GitCommitHorizontal } from "lucide-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import { gitStatus } from "@/lib/transport";
import BranchTreeExplorer from "@/views/BranchTreeExplorer";
import EventTimeline from "@/views/EventTimeline";
import FileExplorer from "@/views/FileExplorer";
import GitStatusView from "@/views/GitStatusView";

export type RightDockTab = "git" | "files" | "history" | "timeline";

/**
 * The right-hand dock hosting the Git (status/diff), Files, History (branch
 * tree) and Timeline (event stream) tabs. The Git tab is only shown when the
 * active workspace is a git repository. Scoped to the active workspace — its
 * children refetch/reset when `workspace` changes.
 */
export default function RightDock({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tab, setTab] = usePersistedState<RightDockTab>("right-dock-tab", "files");
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
	const activeTab: RightDockTab = tab === "git" && !isGitRepo ? "files" : tab;

	const tabs: Array<{ id: RightDockTab; label: string; icon: typeof GitBranch }> = [
		{ id: "history", label: t("history.title"), icon: GitBranch },
		...(isGitRepo ? [{ id: "git" as const, label: t("git.title"), icon: GitCommitHorizontal }] : []),
		{ id: "files", label: t("files.title"), icon: FolderTree },
		{ id: "timeline", label: t("timeline.title"), icon: Activity },
	];

	return (
		<div className="flex h-full flex-col border-l border-border bg-surface">
			{/* Tab strip. The dock toggle buttons live over the main view (see
			    WorkspacePane), so the strip gets the full width. Scrolls
			    horizontally if the dock is dragged narrower than the tabs. */}
			<div className="scrollbar-hide flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5">
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						onClick={() => setTab(id)}
						className={cn(
							"flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
							activeTab === id
								? "bg-surface-2 text-fg"
								: "text-muted hover:bg-surface-2/60 hover:text-fg",
						)}
						title={label}
					>
						<Icon className="h-3.5 w-3.5" />
						<span>{label}</span>
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{activeTab === "git" ? (
					<GitStatusView workspace={workspace} />
				) : activeTab === "files" ? (
					<FileExplorer workspace={workspace} />
				) : activeTab === "history" ? (
					<BranchTreeExplorer workspace={workspace} />
				) : (
					<EventTimeline workspace={workspace} />
				)}
			</div>
		</div>
	);
}
