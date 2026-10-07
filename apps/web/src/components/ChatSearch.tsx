import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, ChevronDown, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

/**
 * Floating "find in conversation" bar. Opened via ⌘/Ctrl+F from AgentView.
 *
 * All match bookkeeping (which items match, the current index) lives in
 * AgentView — this component is purely the input + prev/next/counter UI.
 * Keyboard:
 *   Enter        → next match
 *   Shift+Enter  → previous match
 *   Escape       → close (handled here so the key never reaches the composer)
 */
export function ChatSearch({
	query,
	onQueryChange,
	matchIndex,
	matchCount,
	onPrev,
	onNext,
	onClose,
	focusSignal = 0,
}: {
	query: string;
	onQueryChange: (q: string) => void;
	matchIndex: number;
	matchCount: number;
	onPrev: () => void;
	onNext: () => void;
	onClose: () => void;
	/** Bumped by the parent to imperatively focus+select the input (e.g. on ⌘/Ctrl+F while already open). */
	focusSignal?: number;
}) {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus + select on mount and whenever the parent bumps `focusSignal`
	// (so re-triggering the shortcut while the bar is open refocuses it
	// instead of toggling closed, matching browser/editor find bars).
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, [focusSignal]);

	const counter = matchCount > 0 ? `${matchIndex + 1} / ${matchCount}` : query ? t("search.noResults") : "";

	return (
		<div
			// Render above the drag region / scroll area; stop pointer events from
			// being treated as window-drag. data-tauri-drag-region="false" is the
			// opt-out Tauri's drag.js actually reads; data-no-drag only reaches
			// the Chromium app-region CSS layer.
			data-no-drag
			data-tauri-drag-region="false"
			className={cn(
				"absolute right-4 top-11 flex items-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-1 shadow-lg",
				Z.chrome,
			)}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					onClose();
				} else if (e.key === "Enter") {
					e.preventDefault();
					if (e.shiftKey) onPrev();
					else onNext();
				} else if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
					// ⌘/Ctrl+G → next, Shift+⌘/Ctrl+G → prev (common find-next shortcut).
					e.preventDefault();
					if (e.shiftKey) onPrev();
					else onNext();
				}
			}}
		>
			<Search className="ml-1 h-3.5 w-3.5 shrink-0 text-muted" />
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				placeholder={t("search.placeholder")}
				spellCheck={false}
				// Keep the bar compact; the counter shows on the right.
				className="w-44 bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder:text-muted"
			/>
			<span className="min-w-[3.5rem] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
				{counter}
			</span>
			<button
				type="button"
				onClick={onPrev}
				disabled={matchCount === 0}
				title={t("search.prevHint")}
				className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
			>
				<ChevronUp className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={onNext}
				disabled={matchCount === 0}
				title={t("search.nextHint")}
				className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
			>
				<ChevronDown className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={onClose}
				title={t("search.closeHint")}
				className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}
