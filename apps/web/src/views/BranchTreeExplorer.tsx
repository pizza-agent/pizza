import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Search, RefreshCw, GitFork, CornerUpRight, Pencil, Copy, LogIn, MessageSquare } from "lucide-react";
import {
	historyTreeList,
	historyTreeFork,
	historyTreeJump,
	historyTreeSwitch,
	historyTreeRename,
	subscribeEvents,
} from "@/lib/transport";
import type { RpcHistoryTreeNode } from "@/lib/types";
import { Button, EmptyState, ErrorBanner, Field, Modal, Spinner } from "@/components/ui";
import { cn, samePath } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "@/components/ui";

interface ContextMenuState {
	node: RpcHistoryTreeNode;
	x: number;
	y: number;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * The label a user actually recognizes: the explicit branch name, else the
 * sidecar-derived title (cut from the first user message), else the short id.
 * The session id is a last resort — it means nothing to a human.
 */
function nodeLabel(node: RpcHistoryTreeNode, untitled: string): string {
	return node.name?.trim() || node.title?.trim() || (node.snippet ? untitled : shortId(node.session_id));
}

/** Secondary line: the first user message, hidden when it duplicates the title. */
function nodeSubtitle(node: RpcHistoryTreeNode): string | undefined {
	const snippet = node.snippet?.trim();
	if (!snippet) return undefined;
	const title = (node.name?.trim() || node.title?.trim() || "").replace(/…$/, "");
	if (title && snippet.startsWith(title)) return undefined;
	return snippet;
}

function formatTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return "";
	}
}

/** Compact recency label ("5m", "3h", "2d") — falls back to a date past a week. */
function formatRelative(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "now";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return formatTime(ts);
}

/**
 * Branch Tree Explorer — git-graph style visualization of the session tree
 * for the active workspace. Data comes from the sidecar `history_tree` RPC.
 * Scoped to `workspace`: reloads on workspace change and on SESSION_* events.
 */
export default function BranchTreeExplorer({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [nodes, setNodes] = useState<RpcHistoryTreeNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [renameTarget, setRenameTarget] = useState<RpcHistoryTreeNode | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renaming, setRenaming] = useState(false);
	const queryRef = useRef(query);
	queryRef.current = query;

	// Scroll stabilization for background refreshes. Auto-reload replaces the
	// whole node list; when new sessions insert above the viewport (or rows
	// shift), the browser keeps the pixel scrollTop and the view visibly jumps
	// onto different rows. We anchor to the topmost visible row before the
	// swap and restore its offset after, so what the user is reading stays
	// put. Only the explicit paths (search, switch/jump/fork/rename, workspace
	// change) reset the viewport as user-initiated navigations.
	const listRef = useRef<HTMLDivElement>(null);
	const anchorRef = useRef<{ id: string; offset: number } | null>(null);
	const keepScrollRef = useRef(false);

	const captureAnchor = useCallback(() => {
		const el = listRef.current;
		if (!el) return;
		let topRowId: string | undefined;
		let topRowOffset = 0;
		for (const child of Array.from(el.querySelectorAll<HTMLElement>('[data-session-row]'))) {
			if (child.offsetTop + child.offsetHeight > el.scrollTop) {
				topRowId = child.dataset.sessionRow;
				topRowOffset = child.offsetTop - el.scrollTop;
				break;
			}
		}
		anchorRef.current = topRowId ? { id: topRowId, offset: topRowOffset } : null;
	}, []);

	const restoreAnchor = useCallback(() => {
		const el = listRef.current;
		const anchor = anchorRef.current;
		anchorRef.current = null;
		if (!el || !anchor) return;
		const row = el.querySelector<HTMLElement>('[data-session-row="' + anchor.id + '"]');
		if (row) el.scrollTop = Math.max(0, row.offsetTop - anchor.offset);
	}, []);

	const load = useCallback(async (q?: string) => {
		try {
			setError("");
			const list = await historyTreeList(q ?? (queryRef.current || undefined));
			// The tree arrives in depth-first order, oldest first; the history tab
			// displays newest sessions at the top, so reverse it for display.
			setNodes([...list].reverse());
			if (keepScrollRef.current) {
				keepScrollRef.current = false;
				// Reconcile after React commits the new rows.
				requestAnimationFrame(restoreAnchor);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [restoreAnchor]);

	// Reload on workspace change (data is workspace-scoped).
	// Explicit reload — no anchor capture; the list legitimately resets.
	useEffect(() => {
		setLoading(true);
		setNodes([]);
		setSelected(null);
		void load();
	}, [workspace, load]);

	// Auto-refresh when the session tree changes. The reload keeps the scroll
	// anchored so output arriving mid-browse never yanks the viewport onto
	// other (typically older) conversations.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unlistenP = subscribeEvents((event) => {
			const typed = event as { type?: string; _cwd?: string };
			if (typed._cwd && workspace && !samePath(typed._cwd, workspace)) return;
			if (
				typed.type === "SESSION_CREATED" ||
				typed.type === "SESSION_FORKED" ||
				typed.type === "SESSION_JUMPED"
			) {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					if (cancelled) return;
					captureAnchor();
					keepScrollRef.current = true;
					void load();
				}, 250);
			}
		});
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			unlistenP.then((fn) => fn()).catch(() => {});
		};
	}, [workspace, load, captureAnchor]);

	// Debounced search — user-initiated, so the viewport resets like a fresh list.
	useEffect(() => {
		const timer = setTimeout(() => void load(query || undefined), 200);
		return () => clearTimeout(timer);
	}, [query, load]);

	// Dismiss context menu on any outside click / escape.
	useEffect(() => {
		if (!menu) return;
		const onDown = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const onFork = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		try { await historyTreeFork(node.session_id); await load(); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load]);

	const onJump = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		try { await historyTreeJump(node.session_id); await load(); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load]);

	const onSwitch = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		setSelected(node.session_id);
		if (node.is_active) return;
		try {
			const result = await historyTreeSwitch(node.session_id, "history tree switch");
			setSelected(result.session_id);
			await load();
		}
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load]);

	const onActivate = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		setSelected(node.session_id);
		if (node.is_active) return;
		try {
			const result = await historyTreeSwitch(node.session_id, "history tree row click");
			setSelected(result.session_id);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [load]);

	const onRename = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		setRenameTarget(node);
		// Prefill with the derived title so renaming is a tweak, not retyping.
		setRenameValue(node.name?.trim() || node.title?.trim() || "");
	}, []);

	const submitRename = useCallback(async () => {
		if (!renameTarget || renaming) return;
		setRenaming(true);
		try {
			await historyTreeRename(renameTarget.session_id, renameValue.trim());
			setRenameTarget(null);
			await load();
		}
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
		finally { setRenaming(false); }
	}, [load, renameTarget, renameValue, renaming]);

	const activeNode = nodes.find((n) => n.is_active);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("history.search")}
						className="w-full rounded-md border border-border bg-bg py-1 pl-7 pr-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<button
					onClick={() => void load()}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("history.refresh")}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</button>
			</div>

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Tree */}
			<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : nodes.length === 0 ? (
					<div className="p-4">
						<EmptyState
							title={t("history.emptyTitle")}
							description={query ? t("history.noMatch") : t("history.emptyDescription")}
						/>
					</div>
					) : (
						<ul className="font-mono text-xs">
							{nodes.map((node) => (
								<TreeRow
									key={node.session_id}
									node={node}
									rowId={node.session_id}
									selected={selected === node.session_id}
									onSelect={() => void onActivate(node)}
									onContextMenu={(x, y) => setMenu({ node, x, y })}
								/>
							))}
						</ul>
					)}
			</div>

			{/* Breadcrumb */}
			{activeNode && (
				<div className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted">
					{t("history.position")}: {nodeLabel(activeNode, t("history.untitled"))}
					{activeNode.depth > 0 ? ` · ${t("history.depth")} ${activeNode.depth}` : ` · ${t("history.root")}`}
				</div>
			)}

			{/* Context menu */}
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					onDismiss={() => setMenu(null)}
					items={buildHistoryMenuItems(menu.node, t, {
						onSwitch: () => void onSwitch(menu.node),
						onJump: () => void onJump(menu.node),
						onFork: () => void onFork(menu.node),
						onRename: () => void onRename(menu.node),
						onCopyId: () => void navigator.clipboard?.writeText(menu.node.session_id),
					})}
				/>
			)}

			<Modal
				open={!!renameTarget}
				onClose={() => { if (!renaming) setRenameTarget(null); }}
				size="sm"
				backdrop={false}
				title={t("history.rename")}
				footer={
					<div className="flex w-full items-center justify-end gap-2">
						<Button tone="neutral" variant="ghost" size="sm" disabled={renaming} onClick={() => setRenameTarget(null)}>
							{t("common.dismiss")}
						</Button>
						<Button size="sm" loading={renaming} onClick={() => void submitRename()}>
							{t("common.save")}
						</Button>
					</div>
				}
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void submitRename();
					}}
				>
					<Field label={t("history.renamePrompt")}>
						<input
							autoFocus
							type="text"
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				</form>
			</Modal>
		</div>
	);
}

function buildHistoryMenuItems(
	node: RpcHistoryTreeNode,
	t: (k: string) => string,
	handlers: { onSwitch: () => void; onJump: () => void; onFork: () => void; onRename: () => void; onCopyId: () => void },
): ContextMenuItem[] {
	return [
		{
			icon: LogIn,
			label: t("history.switchHere"),
			hint: node.closed ? t("history.switchClosedHint") : t("history.switchOpenHint"),
			disabled: node.is_active,
			onClick: handlers.onSwitch,
		},
		{
			icon: CornerUpRight,
			label: t("history.jumpHere"),
			hint: node.is_active
				? undefined
				: node.closed
					? t("history.jumpClosedHint")
					: t("history.jumpOpenHint"),
			disabled: node.is_active,
			onClick: handlers.onJump,
		},
		{
			icon: GitFork,
			label: t("history.forkFromHere"),
			hint: t("history.forkHint"),
			onClick: handlers.onFork,
		},
		{
			icon: Pencil,
			label: t("history.rename"),
			onClick: handlers.onRename,
		},
		{ divider: true },
		{
			icon: Copy,
			label: t("history.copyId"),
			onClick: handlers.onCopyId,
		},
	];
}

function TreeRow({
	node,
	rowId,
	selected,
	onSelect,
	onContextMenu,
}: {
	node: RpcHistoryTreeNode;
	/** Stable per-row identity for scroll-anchor restoration across reloads. */
	rowId: string;
	selected: boolean;
	onSelect: () => void;
	onContextMenu: (x: number, y: number) => void;
}) {
	const { t } = useTranslation();
	const indent = node.depth * 14;
	const label = nodeLabel(node, t("history.untitled"));
	const subtitle = nodeSubtitle(node);
	const activityAt = node.last_activity_at ?? node.created_at;
	return (
		<li>
			<div
				data-session-row={rowId}
				onClick={onSelect}
				onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
				title={`${label}\n${node.session_id}\n${formatTime(node.created_at)}${node.snippet ? `\n\n${node.snippet}` : ""}`}
				className={cn(
					"group flex cursor-pointer items-start gap-2 px-3 py-1.5 transition-colors",
					selected ? "bg-accent/10" : "hover:bg-surface-2",
				)}
				style={{ paddingLeft: 12 + indent }}
			>
				{/* Graph dot */}
				<span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
					<span
						className={cn(
							"inline-block h-2 w-2 rounded-full",
							node.is_active
								? "bg-accent ring-2 ring-accent/30"
								: node.closed
									? "border border-muted bg-transparent"
									: "bg-muted",
						)}
					/>
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"truncate",
								node.is_active ? "font-bold text-accent" : "text-fg",
								!node.name?.trim() && !node.title?.trim() && "text-muted",
							)}
						>
							{label}
						</span>
						{node.is_active && (
							<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-accent">
								active
							</span>
						)}
						{!node.is_active && !node.closed && (
							<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-success">
								open
							</span>
						)}
						{node.child_count > 0 && (
							<span className="shrink-0 text-[10px] text-muted">
								<GitBranch className="mr-0.5 inline h-2.5 w-2.5" />
								{node.child_count}
							</span>
						)}
						<span className="ml-auto shrink-0 text-[10px] text-muted" title={formatTime(activityAt)}>
							{formatRelative(activityAt)}
						</span>
					</div>
					{subtitle && <div className="truncate text-[10px] text-muted">↳ {subtitle}</div>}
					{/* Meta line: size at a glance; the opaque id only on hover. */}
					<div className="flex items-center gap-1.5 text-[9px] text-muted/70">
						{!!node.message_count && (
							<span className="inline-flex items-center gap-0.5">
								<MessageSquare className="h-2.5 w-2.5" />
								{node.message_count}
							</span>
						)}
						<span className="truncate opacity-0 transition-opacity group-hover:opacity-70">
							{shortId(node.session_id)}
						</span>
					</div>
				</div>
			</div>
		</li>
	);
}
