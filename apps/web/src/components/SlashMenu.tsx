/**
 * Slash-command popup — shown when the composer input starts with `/`.
 * Lists desktop builtin actions plus the agent-side commands (skills, prompt
 * templates, extension commands) returned by `get_commands`.
 *
 * Presentation mirrors MentionMenu: a flat filtered list with category
 * headers, controlled selection index and scrollIntoView navigation; the
 * Composer owns data, filtering and keyboard handling.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	SlashSquare,
	Sparkles,
	FileText,
	Puzzle,
	Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";
import type { SlashCategory, SlashItem } from "@/lib/slash-commands";

const CATEGORY_ICON: Record<SlashCategory, typeof SlashSquare> = {
	builtin: SlashSquare,
	skill: Sparkles,
	prompt: FileText,
	extension: Puzzle,
};

const CATEGORY_KEY: Record<SlashCategory, string> = {
	builtin: "slash.builtins",
	skill: "slash.skills",
	prompt: "slash.prompts",
	extension: "slash.extensions",
};

type Row =
	| { kind: "header"; category: SlashCategory; key: string }
	| { kind: "item"; item: SlashItem; flatIndex: number; key: string };

function buildRows(items: SlashItem[]): Row[] {
	const rows: Row[] = [];
	let lastCategory: SlashCategory | null = null;
	let flatIndex = 0;
	// Key on category + name + hint so prompt templates and extension commands
	// sharing a name still produce distinct React keys.
	const seen = new Map<string, number>();
	for (const item of items) {
		if (item.category !== lastCategory) {
			rows.push({ kind: "header", category: item.category, key: `header-${item.category}` });
			lastCategory = item.category;
		}
		const base = `item-${item.category}-${item.name}-${item.hint ?? ""}`;
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

export function SlashMenu({
	items,
	selectedIndex,
	onSelect,
	onNavigate,
}: {
	items: SlashItem[];
	selectedIndex: number;
	onSelect: (item: SlashItem) => void;
	onNavigate: (index: number) => void;
}) {
	const { t } = useTranslation();
	const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

	const rows = buildRows(items);
	const itemCount = items.length;
	const clampedIndex = itemCount > 0 ? Math.min(selectedIndex, itemCount - 1) : 0;

	useEffect(() => {
		const el = itemRefs.current.get(clampedIndex);
		el?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	itemRefs.current.clear();

	if (itemCount === 0) {
		return (
			<div className={cn("absolute bottom-full left-0 mb-2 w-80 rounded-xl border border-border bg-surface p-3 shadow-xl", Z.menu)}>
				<div className="flex items-center gap-2 text-xs text-muted">
					<Search className="h-3.5 w-3.5" />
					<span>{t("slash.noResults")}</span>
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
						onMouseMove={() => onNavigate(flatIndex)}
						className={cn(
							"flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
							isSelected ? "bg-surface-2" : "hover:bg-surface-2",
						)}
					>
						<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-fg">
								/{item.name}
								{item.hint && (
									<span className="text-muted"> {item.hint}</span>
								)}
							</span>
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
