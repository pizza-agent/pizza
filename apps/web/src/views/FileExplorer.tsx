import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Folder,
	FolderOpen,
	File as FileIcon,
	Search,
	ChevronRight,
	ChevronDown,
	RefreshCw,
	X,
	Copy,
	ClipboardCopy,
	Eye,
	ExternalLink,
	ChevronsUpDown,
	FolderSearch,
	WrapText,
} from "lucide-react";
import {
	listDir,
	readFileContent,
	openInEditor,
	revealPath,
	type DirEntry,
} from "@/lib/transport";
import { EmptyState, ErrorBanner, Spinner, ContextMenu, IconButton, type ContextMenuItem } from "@/components/ui";
import { CodeViewer } from "@/components/CodeViewer";
import { ResizeHandle } from "@/components/ResizeHandle";
import { languageForPath } from "@/lib/code-lang";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
interface ContextMenuState {
	node: TreeNode;
	x: number;
	y: number;
}

/** Bounds for the draggable tree / preview split, in px. */
const PREVIEW_MIN = 120;
const PREVIEW_MAX = 900;

interface TreeNode extends DirEntry {
	children?: TreeNode[];
	loaded?: boolean;
	loading?: boolean;
}

export default function FileExplorer({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tree, setTree] = useState<TreeNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");
	const [fileLoading, setFileLoading] = useState(false);
	const [fileError, setFileError] = useState("");
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [previewHeight, setPreviewHeight] = usePersistedState<number>("files-preview-height", 320);
	const [wrap, setWrap] = usePersistedState<boolean>("files-preview-wrap", false);

	const cwd = workspace ?? "";

	const clampPreview = useCallback((next: number) => {
		const max = Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, window.innerHeight - 200));
		setPreviewHeight(Math.min(max, Math.max(PREVIEW_MIN, next)));
	}, [setPreviewHeight]);

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

	const absolutePath = useCallback(
		(relPath: string) => (cwd ? `${cwd.replace(/\/$/, "")}/${relPath}` : relPath),
		[cwd],
	);

	const copyText = useCallback((text: string) => {
		try {
			void navigator.clipboard?.writeText(text);
		} catch {
			/* clipboard unavailable; ignore silently */
		}
	}, []);

	const loadRoot = useCallback(async () => {
		if (!cwd) return;
		try {
			setError("");
			const entries = await listDir(cwd);
			setTree(entries.map((e) => ({ ...e, loaded: e.is_dir ? false : undefined })));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		setLoading(true);
		setTree([]);
		setExpanded(new Set());
		setSelectedFile(null);
		setFileContent("");
		void loadRoot();
	}, [cwd, loadRoot]);

	const loadChildren = useCallback(
		async (nodePath: string) => {
			if (!cwd) return;
			setTree((prev) => updateNodeLoading(prev, nodePath, true));
			try {
				const entries = await listDir(cwd, nodePath);
				setTree((prev) =>
					updateNodeChildren(prev, nodePath, entries.map((e) => ({ ...e, loaded: e.is_dir ? false : undefined }))),
				);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[cwd],
	);

	const toggleExpand = useCallback(
		(nodePath: string) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(nodePath)) {
					next.delete(nodePath);
				} else {
					next.add(nodePath);
					// Lazy-load children if not yet loaded.
					const node = findNode(tree, nodePath);
					if (node && node.is_dir && !node.loaded && !node.loading) {
						void loadChildren(nodePath);
					}
				}
				return next;
			});
		},
		[tree, loadChildren],
	);

	const openFile = useCallback(
		async (filePath: string) => {
			if (!cwd) return;
			setSelectedFile(filePath);
			setFileContent("");
			setFileError("");
			setFileLoading(true);
			try {
				const content = await readFileContent(cwd, filePath);
				setFileContent(content);
			} catch (e) {
				setFileError(e instanceof Error ? e.message : String(e));
			} finally {
				setFileLoading(false);
			}
		},
		[cwd],
	);

	// Filtered flat list for search mode.
	const searchResults = useMemo(() => {
		if (!query.trim()) return null;
		// Search through all loaded nodes recursively.
		const results: TreeNode[] = [];
		const walk = (nodes: TreeNode[]) => {
			for (const node of nodes) {
				if (node.name.toLowerCase().includes(query.toLowerCase())) {
					results.push(node);
				}
				if (node.children) walk(node.children);
			}
		};
		walk(tree);
		return results;
	}, [query, tree]);

	const lang = selectedFile ? languageForPath(selectedFile) : "plaintext";
	const selectedNode = selectedFile ? findNode(tree, selectedFile) : null;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("files.search")}
						className="w-full rounded-md border border-border bg-bg py-1 pl-7 pr-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<button
					onClick={() => void loadRoot()}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("files.refresh")}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</button>
			</div>

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Tree or search results */}
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : tree.length === 0 ? (
					<div className="p-4">
						<EmptyState title={t("files.emptyTitle")} description={t("files.emptyDescription")} />
					</div>
				) : query.trim() && searchResults ? (
					<ul className="font-mono text-xs">
						{searchResults.length === 0 ? (
							<li className="px-3 py-2 text-muted">{t("files.noMatch")}</li>
						) : (
							searchResults.map((node) => (
								<li
									key={node.path}
									onClick={() => (node.is_dir ? void toggleExpand(node.path) : void openFile(node.path))}
									onContextMenu={(e) => {
										e.preventDefault();
										setMenu({ node, x: e.clientX, y: e.clientY });
									}}
									className={cn(
										"flex cursor-pointer items-center gap-1.5 px-3 py-1.5 transition-colors hover:bg-surface-2",
										selectedFile === node.path && "bg-accent/10",
									)}
									title={node.path}
								>
									{node.is_dir ? (
										<Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
									) : (
										<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
									)}
									<span className="truncate text-fg">{node.name}</span>
									<span className="ml-auto shrink-0 text-[10px] text-muted">{node.path}</span>
								</li>
							))
						)}
					</ul>
				) : (
					<TreeList
						nodes={tree}
						expanded={expanded}
						selectedFile={selectedFile}
						onToggle={toggleExpand}
						onOpenFile={openFile}
						onContextMenu={(node, x, y) => setMenu({ node, x, y })}
						depth={0}
					/>
				)}
			</div>

			{/* Context menu (rendered via portal-style fixed positioning) */}
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					onDismiss={() => setMenu(null)}
					items={buildFileMenuItems(menu.node, t, {
						absolutePath,
						copyText,
						onView: (node) => void openFile(node.path),
						onOpenInEditor: (node) =>
							openInEditor(cwd, node.path).catch((e) =>
								console.error("openInEditor failed:", e),
							),
						onReveal: (node) =>
							revealPath(cwd, node.path).catch((e) =>
								console.error("revealPath failed:", e),
							),
						onToggleExpand: (node) => void toggleExpand(node.path),
					})}
				/>
			)}

			{/* File preview — draggable split against the tree above. */}
			{selectedFile && (
				<>
					<ResizeHandle
						orientation="horizontal"
						invert
						getSize={() => previewHeight}
						onResize={clampPreview}
						className="border-t border-border"
					/>
					<div className="flex shrink-0 flex-col" style={{ height: previewHeight }}>
						{/* Preview header: file name, meta, actions. */}
						<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-2 py-1.5">
							<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
							<span className="min-w-0 truncate font-mono text-[11px] text-fg" title={selectedFile}>
								{selectedFile.split("/").pop()}
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
								{selectedFile.includes("/") ? selectedFile.slice(0, selectedFile.lastIndexOf("/")) : ""}
							</span>
							<div className="flex shrink-0 items-center gap-1.5 pr-1 font-mono text-[10px] text-muted">
								{lang !== "plaintext" && <span>{lang}</span>}
								{selectedNode && selectedNode.size > 0 && <span>{formatSize(selectedNode.size)}</span>}
							</div>
							<IconButton
								onClick={() => setWrap((v) => !v)}
								title={t("files.toggleWrap")}
								active={wrap}
							>
								<WrapText className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton onClick={() => copyText(fileContent)} title={t("common.copy")}>
								<Copy className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton
								onClick={() => openInEditor(cwd, selectedFile).catch((e) => console.error("openInEditor failed:", e))}
								title={t("files.openInEditor")}
							>
								<ExternalLink className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton
								onClick={() => { setSelectedFile(null); setFileContent(""); setFileError(""); }}
								title={t("files.closeFile")}
							>
								<X className="h-3.5 w-3.5" />
							</IconButton>
						</div>
						{/* Content */}
						<div className="min-h-0 flex-1">
							{fileLoading ? (
								<div className="flex h-full items-center justify-center bg-bg"><Spinner /></div>
							) : fileError ? (
								<div className="bg-bg p-3"><ErrorBanner message={fileError} /></div>
							) : (
								<CodeViewer code={fileContent} language={lang} wrap={wrap} />
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}


function TreeList({
	nodes,
	expanded,
	selectedFile,
	onToggle,
	onOpenFile,
	onContextMenu,
	depth,
}: {
	nodes: TreeNode[];
	expanded: Set<string>;
	selectedFile: string | null;
	onToggle: (path: string) => void;
	onOpenFile: (path: string) => void;
	onContextMenu: (node: TreeNode, x: number, y: number) => void;
	depth: number;
}) {
	return (
		<ul className="font-mono text-xs">
			{nodes.map((node) => (
				<TreeItem
					key={node.path}
					node={node}
					expanded={expanded}
					selectedFile={selectedFile}
					onToggle={onToggle}
					onOpenFile={onOpenFile}
					onContextMenu={onContextMenu}
					depth={depth}
				/>
			))}
		</ul>
	);
}

function TreeItem({
	node,
	expanded,
	selectedFile,
	onToggle,
	onOpenFile,
	onContextMenu,
	depth,
}: {
	node: TreeNode;
	expanded: Set<string>;
	selectedFile: string | null;
	onToggle: (path: string) => void;
	onOpenFile: (path: string) => void;
	onContextMenu: (node: TreeNode, x: number, y: number) => void;
	depth: number;
}) {
	const isOpen = expanded.has(node.path);
	const indent = depth * 16 + 12;

	return (
		<li>
			<div
				onClick={() => (node.is_dir ? onToggle(node.path) : onOpenFile(node.path))}
				onContextMenu={(e) => {
					e.preventDefault();
					onContextMenu(node, e.clientX, e.clientY);
				}}
				className={cn(
					"flex cursor-pointer items-center gap-1.5 py-1 pr-3 transition-colors hover:bg-surface-2",
					selectedFile === node.path && "bg-accent/10",
				)}
				style={{ paddingLeft: indent }}
				title={node.path}
			>
				{node.is_dir ? (
					<>
						{isOpen ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
						)}
						{isOpen ? (
							<FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
						) : (
							<Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
						)}
					</>
				) : (
					<>
						<span className="w-3.5 shrink-0" />
						<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
					</>
				)}
				<span className={cn("truncate", node.is_dir ? "text-fg" : "text-fg")}>
					{node.name}
				</span>
				{!node.is_dir && node.size > 0 && (
					<span className="ml-auto shrink-0 text-[10px] text-muted">{formatSize(node.size)}</span>
				)}
			</div>
			{node.is_dir && isOpen && (
				<>
					{node.loading && !node.loaded ? (
						<div className="flex items-center gap-2 py-1" style={{ paddingLeft: indent + 16 }}>
							<Spinner />
						</div>
					) : node.children && node.children.length > 0 ? (
						<TreeList
							nodes={node.children}
							expanded={expanded}
							selectedFile={selectedFile}
							onToggle={onToggle}
							onOpenFile={onOpenFile}
							onContextMenu={onContextMenu}
							depth={depth + 1}
						/>
					) : (
						<div className="py-1 font-mono text-[10px] text-muted" style={{ paddingLeft: indent + 16 }}>
							(empty)
						</div>
					)}
				</>
			)}
		</li>
	);
}

// --- Menu helpers ---

interface FileMenuHandlers {
	absolutePath: (rel: string) => string;
	copyText: (text: string) => void;
	onView: (node: TreeNode) => void;
	onOpenInEditor: (node: TreeNode) => void;
	onReveal: (node: TreeNode) => void;
	onToggleExpand: (node: TreeNode) => void;
}

/**
 * Build the context-menu items for a file or directory node. Items are split
 * into two visual groups separated by the `---` divider marker (the shared
 * ContextMenu component renders anything between dividers with a separator
 * before it).
 */
function buildFileMenuItems(
	node: TreeNode,
	t: (k: string) => string,
	h: FileMenuHandlers,
): ContextMenuItem[] {
	const abs = h.absolutePath(node.path);
	const items: ContextMenuItem[] = [];

	if (node.is_dir) {
		items.push({
			icon: ChevronsUpDown,
			label: t("files.toggleExpand"),
			onClick: () => h.onToggleExpand(node),
		});
	} else {
		items.push({
			icon: Eye,
			label: t("files.view"),
			onClick: () => h.onView(node),
		});
	}

	items.push({
		icon: ExternalLink,
		label: t("files.openInEditor"),
		onClick: () => h.onOpenInEditor(node),
	});

	items.push({ divider: true });

	items.push({
		icon: FolderSearch,
		label: node.is_dir ? t("files.revealInFiles") : t("files.revealInFilesDir"),
		onClick: () => h.onReveal(node),
	});

	items.push({ divider: true });

	items.push({
		icon: ClipboardCopy,
		label: t("files.copyAbsolutePath"),
		hint: abs,
		onClick: () => h.copyText(abs),
	});
	items.push({
		icon: Copy,
		label: t("files.copyFileName"),
		onClick: () => h.copyText(node.name),
	});
	return items;
}

// --- Tree helpers ---

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const found = findNode(node.children, path);
			if (found) return found;
		}
	}
	return null;
}

function updateNodeLoading(nodes: TreeNode[], path: string, loading: boolean): TreeNode[] {
	return nodes.map((node) => {
		if (node.path === path) {
			return { ...node, loading };
		}
		if (node.children) {
			return { ...node, children: updateNodeLoading(node.children, path, loading) };
		}
		return node;
	});
}

function updateNodeChildren(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
	return nodes.map((node) => {
		if (node.path === path) {
			return { ...node, children, loaded: true, loading: false };
		}
		if (node.children) {
			return { ...node, children: updateNodeChildren(node.children, path, children) };
		}
		return node;
	});
}
