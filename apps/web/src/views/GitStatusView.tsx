import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	GitBranch,
	GitCommitHorizontal,
	ArrowUp,
	ArrowDown,
	RefreshCw,
	X,
	Copy,
	ExternalLink,
	WrapText,
	ChevronDown,
	ChevronRight,
	FilePen,
	FilePlus,
	FileMinus,
	FileQuestion,
	FileSymlink,
	Check,
	Cloud,
	Search,
	CornerDownLeft,
} from "lucide-react";
import {
	gitStatus,
	gitDiff,
	gitLog,
	gitShow,
	gitBranches,
	openInEditor,
	type GitStatusSummary,
	type GitStatusEntry,
	type GitDiffMode,
	type GitLogEntry,
	type GitBranchEntry,
} from "@/lib/transport";
import { EmptyState, ErrorBanner, Spinner, IconButton } from "@/components/ui";
import { DiffViewer } from "@/components/DiffViewer";
import { ResizeHandle } from "@/components/ResizeHandle";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";
import { prefillComposer } from "@/lib/composer-prefill";

/** Bounds for the draggable status-list / diff split, in px. */
const DIFF_MIN = 140;
const DIFF_MAX = 900;

/** How many recent commits to fetch for the history section. */
const COMMIT_LIMIT = 100;

/**
 * The currently-inspected item in the diff pane. The Git tab is read-only, so
 * the diff pane shows either a working-tree file's diff (`file`) or a past
 * commit's diff (`commit`) — never a staging area to mutate.
 */
type Selection =
	| { kind: "file"; path: string; mode: GitDiffMode }
	| { kind: "commit"; hash: string; short: string; subject: string };

/**
 * Git view for the right-dock "Git" tab. The header shows the branch, upstream
 * tracking state and HEAD commit; below it the working tree is grouped into
 * Staged / Changes / Untracked, and selecting a file opens its diff in a
 * resizable pane. A read-only Commits section lists recent history — click a
 * commit to inspect what it changed. Scoped to `workspace` (cwd).
 */
export default function GitStatusView({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [summary, setSummary] = useState<GitStatusSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [commits, setCommits] = useState<GitLogEntry[]>([]);
	const [commitsError, setCommitsError] = useState("");
	const [branches, setBranches] = useState<GitBranchEntry[]>([]);
	const [branchesError, setBranchesError] = useState("");
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const [branchQuery, setBranchQuery] = useState("");
	const branchMenuRef = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [diff, setDiff] = useState("");
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState("");
	const [diffHeight, setDiffHeight] = usePersistedState<number>("git-diff-height", 340);
	const [wrap, setWrap] = usePersistedState<boolean>("git-diff-wrap", false);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["commits"]));

	const cwd = workspace ?? "";

	const clampDiff = useCallback((next: number) => {
		const max = Math.min(DIFF_MAX, Math.max(DIFF_MIN, window.innerHeight - 200));
		setDiffHeight(Math.min(max, Math.max(DIFF_MIN, next)));
	}, [setDiffHeight]);

	const load = useCallback(async () => {
		if (!cwd) {
			setSummary(null);
			setCommits([]);
		setBranches([]);
			setLoading(false);
			return;
		}
		// Status is primary; commits are best-effort and must never block it.
		try {
			setError("");
			setSummary(await gitStatus(cwd));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
		try {
			setCommitsError("");
			setCommits(await gitLog(cwd, COMMIT_LIMIT));
		} catch (e) {
			setCommitsError(e instanceof Error ? e.message : String(e));
			setCommits([]);
		}
		// Branches are best-effort too — never block the status load.
		try {
			setBranchesError("");
			setBranches(await gitBranches(cwd));
		} catch (e) {
			setBranchesError(e instanceof Error ? e.message : String(e));
			setBranches([]);
		}
	}, [cwd]);

	useEffect(() => {
		setLoading(true);
		setSummary(null);
		setCommits([]);
		setBranches([]);
		setSelection(null);
		setDiff("");
		void load();
	}, [cwd, load]);

	const openDiff = useCallback(
		async (path: string, mode: GitDiffMode) => {
			if (!cwd) return;
			setSelection({ kind: "file", path, mode });
			setDiff("");
			setDiffError("");
			setDiffLoading(true);
			try {
				setDiff(await gitDiff(cwd, path, mode));
			} catch (e) {
				setDiffError(e instanceof Error ? e.message : String(e));
			} finally {
				setDiffLoading(false);
			}
		},
		[cwd],
	);

	const openCommit = useCallback(
		async (hash: string, short: string, subject: string) => {
			if (!cwd) return;
			setSelection({ kind: "commit", hash, short, subject });
			setDiff("");
			setDiffError("");
			setDiffLoading(true);
			try {
				// A root/merge commit with no textual changes yields "" — the empty
				// diff renders the shared "no diff" placeholder below.
				setDiff(await gitShow(cwd, hash));
			} catch (e) {
				setDiffError(e instanceof Error ? e.message : String(e));
			} finally {
				setDiffLoading(false);
			}
		},
		[cwd],
	);

	// Re-fetch the open diff after a refresh so it never shows stale content.
	const refresh = useCallback(async () => {
		await load();
		if (!selection) return;
		if (selection.kind === "file") await openDiff(selection.path, selection.mode);
		else await openCommit(selection.hash, selection.short, selection.subject);
	}, [load, selection, openDiff, openCommit]);

	// Group into staged / unstaged / untracked. An entry can appear in both the
	// staged and unstaged groups (e.g. "MM" — staged edit plus further edits).
	const groups = useMemo(() => {
		const staged: GitStatusEntry[] = [];
		const unstaged: GitStatusEntry[] = [];
		const untracked: GitStatusEntry[] = [];
		for (const e of summary?.entries ?? []) {
			if (e.xy === "??") {
				untracked.push(e);
				continue;
			}
			const [x, y] = [e.xy.charCodeAt(0), e.xy.charCodeAt(1)];
			if (x !== 32 && x !== 63) staged.push(e); // X is not ' ' or '?'
			if (y !== 32 && y !== 63) unstaged.push(e); // Y is not ' ' or '?'
		}
		return [
			{ key: "staged", label: t("git.staged"), mode: "staged" as GitDiffMode, entries: staged },
			{ key: "unstaged", label: t("git.unstaged"), mode: "worktree" as GitDiffMode, entries: unstaged },
			{ key: "untracked", label: t("git.untracked"), mode: "untracked" as GitDiffMode, entries: untracked },
		].filter((g) => g.entries.length > 0);
	}, [summary, t]);

	// Repo-wide totals for the header stat badge.
	const totals = useMemo(() => {
		let added = 0;
		let removed = 0;
		for (const e of summary?.entries ?? []) {
			added += e.additions ?? 0;
			removed += e.deletions ?? 0;
		}
		return { added, removed };
	}, [summary]);

	// Branches: current first, then the rest of the locals, then remotes — so the
	// active branch is always visible without scrolling, mirroring `git branch`.
	const sortedBranches = useMemo(() => {
		const locals = branches.filter((b) => !b.is_remote);
		const remotes = branches.filter((b) => b.is_remote);
		const rank = (b: GitBranchEntry) => (b.is_current ? 0 : 1);
		locals.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		remotes.sort((a, b) => a.name.localeCompare(b.name));
		return [...locals, ...remotes];
	}, [branches]);

	// Branches matching the search box (case-insensitive substring on the name).
	const filteredBranches = useMemo(() => {
		const q = branchQuery.trim().toLowerCase();
		if (!q) return sortedBranches;
		return sortedBranches.filter((b) => b.name.toLowerCase().includes(q));
	}, [sortedBranches, branchQuery]);

	// Hand branch switching to the agent: prefill the composer with a prompt so
	// the action runs through the agent (logged, conflict-aware) rather than a
	// silent UI checkout the agent wouldnt know about.
	const switchInChat = useCallback((name: string) => {
		prefillComposer(cwd, `Switch to the ${name} branch.`);
		setBranchMenuOpen(false);
		setBranchQuery("");
	}, [cwd]);

	// Close the branch menu on outside click.
	useEffect(() => {
		if (!branchMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
				setBranchMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [branchMenuOpen]);

	const toggleGroup = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const clean = !!summary && summary.entries.length === 0;

	return (
		<div className="flex h-full flex-col">
			{/* Branch bar */}
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
				<GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
				<div className="relative">
					<button
						type="button"
						disabled={branches.length === 0}
						onClick={() => setBranchMenuOpen((v) => !v)}
						className={cn(
							"flex min-w-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-xs text-fg transition-colors",
							branches.length > 0 && "hover:bg-surface-2",
							branches.length > 0 && branchMenuOpen && "bg-surface-2",
						)}
						title={branches.length > 0 ? t("git.branchesMenu") : summary?.branch || undefined}
					>
						<span className="min-w-0 truncate">{summary?.branch || t("git.detached")}</span>
						{branches.length > 0 && (
							<ChevronDown className={cn("h-3 w-3 shrink-0 text-muted transition-transform", branchMenuOpen && "rotate-180")} />
						)}
					</button>
					{/* Read-only branch picker, anchored right under the branch name. */}
					{branchMenuOpen && (
						<BranchMenu
							ref={branchMenuRef}
							branches={filteredBranches}
							total={branches.length}
							query={branchQuery}
							onQuery={setBranchQuery}
							onSwitch={switchInChat}
							error={branchesError}
						/>
					)}
				</div>
				{summary?.ahead ? (
					<span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-accent" title={t("git.ahead")}>
						<ArrowUp className="h-3 w-3" />
						{summary.ahead}
					</span>
				) : null}
				{summary?.behind ? (
					<span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-warning" title={t("git.behind")}>
						<ArrowDown className="h-3 w-3" />
						{summary.behind}
					</span>
				) : null}
				{summary?.upstream && (
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={summary.upstream}>
						{summary.upstream}
					</span>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<DiffStatBadge added={totals.added} removed={totals.removed} />
					<IconButton onClick={() => void refresh()} title={t("git.refresh")}>
						<RefreshCw className="h-3.5 w-3.5" />
					</IconButton>
				</div>
			</div>

			{/* HEAD commit */}
			{summary?.head && (
				<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-3 py-1.5 font-mono text-[10px] text-muted">
					<GitCommitHorizontal className="h-3 w-3 shrink-0" />
					<span className="shrink-0 text-fg">{summary.head}</span>
					<span className="min-w-0 truncate" title={summary.head_subject}>{summary.head_subject}</span>
				</div>
			)}

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Status list + Commits */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : (
					<>
						{clean ? (
							<div className="p-4">
								<EmptyState title={t("git.cleanTitle")} description={t("git.cleanDescription")} />
							</div>
						) : (
							groups.map((group) => (
								<StatusGroup
									key={group.key}
									label={group.label}
									count={group.entries.length}
									entries={group.entries}
									collapsed={collapsed.has(group.key)}
									onToggle={() => toggleGroup(group.key)}
									selection={selection?.kind === "file" ? selection : null}
									mode={group.mode}
									onSelect={(path) => void openDiff(path, group.mode)}
								/>
							))
						)}

						{/* Read-only commit history. Always shown (even when clean) so the
						    user can audit what landed in the repo — but only the latest
						    COMMIT_LIMIT entries; for anything deeper, ask the agent. */}
						{commitsError ? (
							<div className="px-2 pt-2"><ErrorBanner message={commitsError} /></div>
						) : commits.length > 0 ? (
							<CommitsGroup
								commits={commits}
								collapsed={collapsed.has("commits")}
								onToggle={() => toggleGroup("commits")}
								selection={selection?.kind === "commit" ? selection : null}
								onSelect={(c) => void openCommit(c.hash, c.short, c.subject)}
							/>
						) : null}
					</>
				)}
			</div>

			{/* Diff pane — draggable split against the list above. */}
			{selection && (
				<>
					<ResizeHandle
						orientation="horizontal"
						invert
						getSize={() => diffHeight}
						onResize={clampDiff}
						className="border-t border-border"
					/>
					<div className="flex shrink-0 flex-col" style={{ height: diffHeight }}>
						<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-2 py-1.5">
							{selection.kind === "file" ? (
								<>
									<span className="min-w-0 truncate font-mono text-[11px] text-fg" title={selection.path}>
										{selection.path.split("/").pop()}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
										{selection.path.includes("/") ? selection.path.slice(0, selection.path.lastIndexOf("/")) : ""}
									</span>
									<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
										{t(`git.mode.${selection.mode}`)}
									</span>
									<IconButton
										onClick={() => openInEditor(cwd, selection.path).catch((e) => console.error("openInEditor failed:", e))}
										title={t("files.openInEditor")}
									>
										<ExternalLink className="h-3.5 w-3.5" />
									</IconButton>
								</>
							) : (
								<>
									<GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-accent" />
									<span className="shrink-0 font-mono text-[11px] text-accent">{selection.short}</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={selection.subject}>
										{selection.subject}
									</span>
									<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
										{t("git.commit")}
									</span>
								</>
							)}
							<IconButton onClick={() => setWrap((v) => !v)} title={t("files.toggleWrap")} active={wrap}>
								<WrapText className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton onClick={() => navigator.clipboard?.writeText(diff)} title={t("common.copy")}>
								<Copy className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton onClick={() => { setSelection(null); setDiff(""); setDiffError(""); }} title={t("git.closeDiff")}>
								<X className="h-3.5 w-3.5" />
							</IconButton>
						</div>
						<div className="min-h-0 flex-1">
							{diffLoading ? (
								<div className="flex h-full items-center justify-center bg-bg"><Spinner /></div>
							) : diffError ? (
								<div className="bg-bg p-3"><ErrorBanner message={diffError} /></div>
							) : diff ? (
								<DiffViewer text={diff} wrap={wrap} />
							) : (
								<div className="h-full bg-bg p-3 font-mono text-[11px] text-muted">{t("git.noDiff")}</div>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

/** Compact "+N −M" badge; renders nothing when there is no change to show. */
function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
	if (added === 0 && removed === 0) return null;
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
			{added > 0 && <span className="text-success">+{added}</span>}
			{removed > 0 && <span className="text-danger">−{removed}</span>}
		</span>
	);
}

function StatusGroup({
	label,
	count,
	entries,
	collapsed,
	onToggle,
	selection,
	mode,
	onSelect,
}: {
	label: string;
	count: number;
	entries: GitStatusEntry[];
	collapsed: boolean;
	onToggle: () => void;
	selection: { path: string; mode: GitDiffMode } | null;
	mode: GitDiffMode;
	onSelect: (path: string) => void;
}) {
	return (
		<div>
			{/* Sticky group header so the section stays identifiable while scrolling. */}
			<button
				onClick={onToggle}
				className="sticky top-0 z-10 flex w-full items-center gap-1 bg-surface px-2 py-1 text-left text-[11px] font-medium text-muted transition-colors hover:text-fg"
			>
				{collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
				<span>{label}</span>
				<span className="rounded bg-surface-2 px-1 text-[9px] normal-case">{count}</span>
			</button>
			{!collapsed && (
				<ul>
					{entries.map((e) => (
						<StatusRow
							key={`${mode}-${e.path}`}
							entry={e}
							selected={selection?.path === e.path && selection.mode === mode}
							onSelect={() => onSelect(e.path)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function StatusRow({
	entry,
	selected,
	onSelect,
}: {
	entry: GitStatusEntry;
	selected: boolean;
	onSelect: () => void;
}) {
	const { Icon, color, code } = describeStatus(entry.xy);
	const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
	const name = entry.path.split("/").pop() ?? entry.path;
	return (
		<li
			onClick={onSelect}
			className={cn(
				"flex cursor-pointer items-center gap-1.5 px-2 py-1 font-mono text-xs transition-colors hover:bg-surface-2",
				selected && "bg-accent/10",
			)}
			title={entry.orig_path ? `${entry.orig_path} → ${entry.path}` : entry.path}
		>
			<Icon className={cn("h-3.5 w-3.5 shrink-0", color)} />
			{/* Filename gets priority; the directory is de-emphasised and is the
			    first thing to be truncated in a narrow dock (full path in title). */}
			<span className="shrink-0 text-fg">{name}</span>
			<span className="min-w-0 flex-1 truncate text-[10px] text-muted">{dir}</span>
			<DiffStatBadge added={entry.additions ?? 0} removed={entry.deletions ?? 0} />
			<span className={cn("w-4 shrink-0 text-right text-[10px]", color)}>{code}</span>
		</li>
	);
}

/**
 * Map a porcelain status code to an icon, color and single-letter label.
 * The letter is shown alongside the icon so status is never conveyed by
 * color alone.
 */
function describeStatus(xy: string): { Icon: typeof FilePen; color: string; code: string } {
	if (xy === "??") return { Icon: FileQuestion, color: "text-muted", code: "U" };
	// The interesting code is whichever of X/Y is not a space.
	const code = xy[0] !== " " ? xy[0]! : xy[1]!;
	switch (code) {
		case "A": return { Icon: FilePlus, color: "text-success", code: "A" };
		case "D": return { Icon: FileMinus, color: "text-danger", code: "D" };
		case "R": return { Icon: FileSymlink, color: "text-accent", code: "R" };
		case "C": return { Icon: FileSymlink, color: "text-accent", code: "C" };
		case "U": return { Icon: FileQuestion, color: "text-warning", code: "!" };
		default: return { Icon: FilePen, color: "text-warning", code: "M" };
	}
}

/** Read-only, collapsible commit history section. */
function CommitsGroup({
	commits,
	collapsed,
	onToggle,
	selection,
	onSelect,
}: {
	commits: GitLogEntry[];
	collapsed: boolean;
	onToggle: () => void;
	selection: { hash: string } | null;
	onSelect: (c: GitLogEntry) => void;
}) {
	const { t } = useTranslation();
	return (
		<div>
			<button
				onClick={onToggle}
				className="sticky top-0 z-10 flex w-full items-center gap-1 bg-surface px-2 py-1 text-left text-[11px] font-medium text-muted transition-colors hover:text-fg"
			>
				{collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
				<span>{t("git.commits")}</span>
				<span className="rounded bg-surface-2 px-1 text-[9px] normal-case">{commits.length}</span>
			</button>
			{!collapsed && (
				<ul>
					{commits.map((c) => (
						<CommitRow
							key={c.hash}
							entry={c}
							selected={selection?.hash === c.hash}
							onSelect={() => onSelect(c)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function CommitRow({
	entry,
	selected,
	onSelect,
}: {
	entry: GitLogEntry;
	selected: boolean;
	onSelect: () => void;
}) {
	// ISO date → "YYYY-MM-DD" for a compact, locale-stable timestamp.
	const date = entry.date.slice(0, 10);
	return (
		<li
			onClick={onSelect}
			className={cn(
				"flex cursor-pointer flex-col gap-0.5 px-2 py-1 font-mono text-xs transition-colors hover:bg-surface-2",
				selected && "bg-accent/10",
			)}
			title={`${entry.short} · ${entry.author} · ${entry.date}\n${entry.subject}`}
		>
			<div className="flex items-center gap-1.5">
				<GitCommitHorizontal className="h-3 w-3 shrink-0 text-muted" />
				<span className="shrink-0 text-accent">{entry.short}</span>
				<span className="min-w-0 flex-1 truncate text-fg">{entry.subject}</span>
				{entry.refs && (
					<span className="max-w-[40%] shrink-0 truncate rounded bg-surface-2 px-1 text-[9px] text-muted" title={entry.refs}>
						{entry.refs}
					</span>
				)}
			</div>
			<div className="flex items-center gap-1.5 pl-[18px] text-[10px] text-muted">
				<span className="min-w-0 flex-1 truncate">{entry.author}</span>
				<span className="shrink-0">{date}</span>
			</div>
		</li>
	);
}


/**
 * Read-only branch picker shown as a popover under the Git tab's branch bar.
 * Lists local + remote branches behind a search box; each row offers to switch
 * to that branch *in chat* (the agent runs the checkout so it is logged and
 * conflict-aware) rather than performing a silent UI checkout.
 *
 * Anchored absolutely under the branch bar; the parent passes a ref so it can
 * close on outside click.
 */
const BranchMenu = forwardRef<HTMLDivElement, {
	branches: GitBranchEntry[];
	/** Total branch count before filtering (for the "N of M" hint). */
	total: number;
	query: string;
	onQuery: (q: string) => void;
	onSwitch: (name: string) => void;
	error?: string;
}>(function BranchMenu({ branches, total, query, onQuery, onSwitch, error }, ref) {
	const { t } = useTranslation();
	return (
		<div
			ref={ref}
			className={cn("absolute left-0 top-full flex w-64 max-h-72 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-lg", Z.menu)}
		>
			{/* Search box */}
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
				<Search className="h-3.5 w-3.5 shrink-0 text-muted" />
				<input
					autoFocus
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					placeholder={t("git.branchSearch")}
					className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:text-muted/60"
				/>
				{query && (
					<span className="shrink-0 font-mono text-[10px] text-muted">
						{branches.length}/{total}
					</span>
				)}
			</div>
			{/* List */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{error ? (
					<div className="px-2 py-2"><ErrorBanner message={error} /></div>
				) : branches.length === 0 ? (
					<div className="px-2 py-3 font-mono text-[11px] text-muted">{t("git.branchNoMatch")}</div>
				) : (
					<ul>
						{branches.map((b) => {
							const Icon = b.is_remote ? Cloud : GitBranch;
							return (
								<li
									key={`${b.is_remote ? "r" : "l"}-${b.name}`}
									className="flex items-center gap-1.5 px-2 py-1 font-mono text-xs hover:bg-surface-2"
									title={b.upstream ? `${t("git.branchesTracks")}: ${b.upstream}` : b.name}
								>
									{b.is_current ? (
										<Check className="h-3.5 w-3.5 shrink-0 text-accent" />
									) : (
										<Icon className={cn("h-3.5 w-3.5 shrink-0", b.is_remote ? "text-muted/60" : "text-muted")} />
									)}
									<span className={cn("min-w-0 flex-1 truncate", b.is_current ? "text-accent" : b.is_remote ? "text-muted" : "text-fg")}>
										{b.name}
									</span>
									{b.is_current && (
										<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-accent">HEAD</span>
									)}
									{/* The only write affordance: hand it to the agent via chat. */}
									<button
										type="button"
										disabled={b.is_current}
										onClick={() => onSwitch(b.name)}
										className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-accent/10 hover:text-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
										title={b.is_current ? t("git.currentBranch") : t("git.switchInChat")}
									>
										<CornerDownLeft className="h-3 w-3" />
										<span>{t("git.switchInChat")}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
});
