/**
 * Mention popup — shown when the user types `@` in the composer textarea.
 * Lists categorised items (files, branches, workspaces, skills, scheduled
 * tasks) that can be inserted as references into the message.
 *
 * The Composer owns the data fetching, filtering, and keyboard navigation;
 * this component is purely presentational. It receives an already-filtered
 * flat list and a `selectedIndex`, and calls `onSelect`/`onNavigate` on user
 * interaction.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	File as FileIcon,
	GitBranch,
	FolderOpen,
	Sparkles,
	Clock,
	Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

export type MentionCategory = "file" | "branch" | "workspace" | "skill" | "schedule";

export interface MentionItem {
	category: MentionCategory;
	/** Primary display label. */
	label: string;
	/** Secondary text (path, description, etc.). */
	description?: string;
	/** Value inserted into the textarea on selection. */
	insertText: string;
	/** For file mentions: the absolute path to attach as a file reference. */
	absolutePath?: string;
}

interface MentionMenuProps {
	/** Already-filtered flat list of items to display. */
	items: MentionItem[];
	/** Currently selected index (controlled by the Composer). */
	selectedIndex: number;
	/** Called when the user picks an item (click or Enter). */
	onSelect: (item: MentionItem) => void;
	/** Called when the user hovers an item with the mouse. */
	onNavigate: (index: number) => void;
}

const CATEGORY_ICON: Record<MentionCategory, typeof FileIcon> = {
	file: FileIcon,
	branch: GitBranch,
	workspace: FolderOpen,
	skill: Sparkles,
	schedule: Clock,
};

const CATEGORY_KEY: Record<MentionCategory, string> = {
	file: "mention.files",
	branch: "mention.branches",
	workspace: "mention.workspaces",
	skill: "mention.skills",
	schedule: "mention.schedules",
};

/**
 * Pre-compute the render rows: a flat array of either "header" or "item" rows,
 * where each "item" row carries its flat index. This avoids the `let runningIndex`
 * anti-pattern in JSX (which double-counts under React StrictMode) and makes
 * scrollIntoView target the correct DOM node.
 */
type Row =
	| { kind: "header"; category: MentionCategory; key: string }
	| { kind: "item"; item: MentionItem; flatIndex: number; key: string };

function buildRows(items: MentionItem[]): Row[] {
	const rows: Row[] = [];
	let lastCategory: MentionCategory | null = null;
	let flatIndex = 0;
	// Row keys must be unique: many files share a basename (index.ts,
	// package.json…), so keying on the label alone collides and React drops or
	// mixes up rows in the filtered list. We key on category + insertText +
	// description (unique for files/workspaces), and de-duplicate defensively so
	// even two identically-named schedules can never collide.
	const seen = new Map<string, number>();
	for (const item of items) {
		if (item.category !== lastCategory) {
			rows.push({ kind: "header", category: item.category, key: `header-${item.category}` });
			lastCategory = item.category;
		}
		const base = `item-${item.category}-${item.insertText}-${item.description ?? ""}`;
		const dupes = seen.get(base) ?? 0;
		seen.set(base, dupes + 1);
		rows.push({
			kind: "item",
			item,
			flatIndex,
			key: dupes === 0 ? base : `${base}#${dupes}`,
		});
		flatIndex++;
	}
	return rows;
}

export function MentionMenu({
	items,
	selectedIndex,
	onSelect,
	onNavigate,
}: MentionMenuProps) {
	const { t } = useTranslation();
	// Ref store mapping flatIndex → DOM button, for scrollIntoView.
	const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

	// Pre-compute rows once per render (cheap, and avoids StrictMode issues).
	const rows = buildRows(items);

	// Clamp selectedIndex to the valid range of flat items.
	const itemCount = items.length;
	const clampedIndex = itemCount > 0 ? Math.min(selectedIndex, itemCount - 1) : 0;

	// Scroll the selected item into view when the index changes.
	useEffect(() => {
		const el = itemRefs.current.get(clampedIndex);
		el?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	// Clear the ref map on unmount / before rebuild to avoid stale entries.
	itemRefs.current.clear();

	if (itemCount === 0) {
		return (
			<div className={cn("absolute bottom-full left-0 mb-2 w-80 rounded-xl border border-border bg-surface p-3 shadow-xl", Z.menu)}>
				<div className="flex items-center gap-2 text-xs text-muted">
					<Search className="h-3.5 w-3.5" />
					<span>{t("mention.noResults")}</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn("absolute bottom-full left-0 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl", Z.menu)}
		>
			{rows.map((row) => {
				if (row.kind === "header") {
					return (
						<div key={row.key} className="px-2 py-1 text-[11px] font-medium text-muted">
							{t(CATEGORY_KEY[row.category])}
						</div>
					);
				}
				const { item, flatIndex } = row;
				const Icon = CATEGORY_ICON[item.category];
				const isSelected = flatIndex === clampedIndex;
				return (
					<button
						key={row.key}
						ref={(el) => {
							if (el) itemRefs.current.set(flatIndex, el);
						}}
						type="button"
						onClick={() => onSelect(item)}
						// Use onMouseMove (not onMouseEnter) so the highlight only
						// changes when the user actually moves the mouse — not when
						// items re-render under a stationary cursor during keyboard
						// navigation.
						onMouseMove={() => onNavigate(flatIndex)}
						className={cn(
							"flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
							isSelected ? "bg-surface-2" : "hover:bg-surface-2",
						)}
					>
						<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-fg">{item.label}</span>
							{item.description && (
								<span className="block truncate text-[10px] text-muted">
									{item.description}
								</span>
							)}
						</span>
					</button>
				);
			})}
		</div>
	);
}
