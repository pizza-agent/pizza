import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TerminalSquare,
	ChevronDown,
	Plus,
	X,
	SplitSquareVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Terminal from "./Terminal";

/**
 * The bottom dock hosting one or more interactive terminals, scoped to the
 * active workspace. Mirrors the terminal panels found in modern IDEs:
 *
 *  - A tab strip across the top; each tab owns one or more stacked terminal
 *    panes. Switching tabs keeps every PTY alive (panes are mounted but
 *    hidden while inactive).
 *  - "New tab" (+) creates a fresh single-pane tab.
 *  - "Split" (⇕) splits the focused pane vertically — stacking a new terminal
 *    below the current one. The divider between two stacked panes can be
 *    dragged up/down to resize them.
 *  - Close (×) on a tab chip closes the whole tab; close on a pane removes
 *    just that terminal.
 *
 * Collapsing the dock is owned by the parent (WorkspacePane); this component
 * only requests collapse via `onCollapse`.
 */

interface Pane {
	id: string;
	/** flex-grow weight controlling this pane's share of the tab height. */
	weight: number;
}

interface Tab {
	id: string;
	panes: Pane[];
	activePaneId: string;
}

let _seq = 0;
const uid = (p: string): string => `${p}-${++_seq}`;

const newTab = (): Tab => {
	const paneId = uid("pane");
	return { id: uid("tab"), panes: [{ id: paneId, weight: 1 }], activePaneId: paneId };
};

const MIN_PANE_RATIO = 0.12;

export default function BottomDock({
	workspace,
	ptyPort,
	onCollapse,
}: {
	workspace?: string | null;
	ptyPort?: number;
	onCollapse: () => void;
}) {
	const { t } = useTranslation();
	const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
	const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]!.id);
	/** Per-tab body height capture for weight-based split dragging. */
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{
		tabId: string;
		index: number;
		startY: number;
		pairPx: number;
		startFrac: number;
	} | null>(null);

	/* ---------- tabs ---------- */

	const addTab = useCallback(() => {
		setTabs((prev) => {
			const tb = newTab();
			setActiveTabId(tb.id);
			return [...prev, tb];
		});
	}, []);

	const closeTab = useCallback(
		(id: string) => {
			setTabs((prev) => {
				if (prev.length <= 1) {
					// Always keep at least one tab; reset it to a fresh pane.
					const fresh = newTab();
					setActiveTabId(fresh.id);
					return [fresh];
				}
				const idx = prev.findIndex((tb) => tb.id === id);
				const next = prev.filter((tb) => tb.id !== id);
				if (id === activeTabId) {
					const neighbor = next[Math.min(idx, next.length - 1)]!;
					setActiveTabId(neighbor.id);
				}
				return next;
			});
		},
		[activeTabId],
	);

	/* ---------- panes (vertical splits) ---------- */

	const splitPane = useCallback(() => {
		setTabs((prev) =>
			prev.map((tb) => {
				if (tb.id !== activeTabId) return tb;
				const i = tb.panes.findIndex((p) => p.id === tb.activePaneId);
				if (i < 0) return tb;
				const cur = tb.panes[i]!;
				const half = cur.weight / 2;
				const paneId = uid("pane");
				const panes = [...tb.panes];
				panes[i] = { ...cur, weight: half };
				panes.splice(i + 1, 0, { id: paneId, weight: half });
				return { ...tb, panes, activePaneId: paneId };
			}),
		);
	}, [activeTabId]);

	const closePane = useCallback((tabId: string, paneId: string) => {
		setTabs((prev) =>
			prev.flatMap((tb) => {
				if (tb.id !== tabId) return [tb];
				if (tb.panes.length <= 1) {
					// Closing the last pane of a tab closes the tab (unless it is
					// the only tab left, which we reset instead).
					if (prev.length <= 1) {
						const fresh = newTab();
						setActiveTabId(fresh.id);
						return [fresh];
					}
					if (tabId === activeTabId) {
						const idx = prev.findIndex((p) => p.id === tabId);
						const next = prev.filter((p) => p.id !== tabId);
						const neighbor = next[Math.min(idx, next.length - 1)]!;
						setActiveTabId(neighbor.id);
						return [];
					}
					return [];
				}
				const remaining = tb.panes.filter((p) => p.id !== paneId);
				// Redistribute the closed pane's weight across the survivors.
				const lost = tb.panes.find((p) => p.id === paneId)?.weight ?? 0;
				const share = remaining.length ? lost / remaining.length : 0;
				const panes = remaining.map((p) => ({ ...p, weight: p.weight + share }));
				const activePaneId = tb.activePaneId === paneId ? panes[0]!.id : tb.activePaneId;
				return [{ ...tb, panes, activePaneId }];
			}),
		);
	}, [activeTabId]);

	const focusPane = useCallback((tabId: string, paneId: string) => {
		setTabs((prev) => prev.map((tb) => (tb.id === tabId ? { ...tb, activePaneId: paneId } : tb)));
		setActiveTabId(tabId);
	}, []);

	/* ---------- split drag (up/down to resize stacked panes) ---------- */

	const onSplitPointerDown = useCallback(
		(e: React.PointerEvent, tabId: string, index: number) => {
			const body = bodyRef.current;
			const tb = tabs.find((t) => t.id === tabId);
			if (!body || !tb) return;
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			const totalW = tb.panes.reduce((s, p) => s + p.weight, 0) || 1;
			const sumW = tb.panes[index]!.weight + tb.panes[index + 1]!.weight;
			const pairPx = (sumW / totalW) * body.getBoundingClientRect().height;
			const startFrac = tb.panes[index]!.weight / sumW;
			dragRef.current = { tabId, index, startY: e.clientY, pairPx, startFrac };
		},
		[tabs],
	);

	const onSplitPointerMove = useCallback((e: React.PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || !(e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) return;
		const delta = e.clientY - drag.startY;
		const curFrac = clamp(
			drag.startFrac + delta / drag.pairPx,
			MIN_PANE_RATIO,
			1 - MIN_PANE_RATIO,
		);
		setTabs((prev) =>
			prev.map((tb) => {
				if (tb.id !== drag.tabId) return tb;
				const panes = [...tb.panes];
				const a = panes[drag.index]!;
				const b = panes[drag.index + 1]!;
				const sum = a.weight + b.weight;
				const newA = curFrac * sum;
				panes[drag.index] = { ...a, weight: newA };
				panes[drag.index + 1] = { ...b, weight: sum - newA };
				return { ...tb, panes };
			}),
		);
	}, []);

	const onSplitPointerUp = useCallback((e: React.PointerEvent) => {
		if (dragRef.current) {
			try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		}
		dragRef.current = null;
	}, []);

	const tabTitle = (tb: Tab, i: number): string => `${t("terminal.title")} ${i + 1}`;

	return (
		<div className="flex h-full flex-col border-t border-border bg-bg">
			{/* Header: tab strip + actions. */}
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-1.5 pr-2">
				<TerminalSquare className="mr-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
					{tabs.map((tb, i) => {
						const active = tb.id === activeTabId;
						return (
							<div
								key={tb.id}
								onClick={() => setActiveTabId(tb.id)}
								className={cn(
									"group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
									active
										? "bg-surface-2 text-fg"
										: "text-muted hover:bg-surface-2/60 hover:text-fg",
								)}
								title={tabTitle(tb, i)}
							>
								<span>{tabTitle(tb, i)}</span>
								{tb.panes.length > 1 && (
									<span className="rounded bg-surface-2 px-1 text-[9px] text-muted">
										{tb.panes.length}
									</span>
								)}
								{tabs.length > 1 && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											closeTab(tb.id);
										}}
										className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
										title={t("terminal.closeTab")}
									>
										<X className="h-3 w-3" />
									</button>
								)}
							</div>
						);
					})}
					<button
						onClick={addTab}
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("terminal.newTab")}
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						onClick={splitPane}
						className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("terminal.split")}
					>
						<SplitSquareVertical className="h-3.5 w-3.5" />
					</button>
					<button
						onClick={onCollapse}
						className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("terminal.collapse")}
					>
						<ChevronDown className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{/* Body: render every tab so PTY sessions survive tab switches; only
			    the active tab is laid out, the rest are hidden. */}
			<div ref={bodyRef} className="relative min-h-0 flex-1">
				{tabs.map((tb) => {
					const active = tb.id === activeTabId;
					return (
						<div
							key={tb.id}
							className={cn("h-full w-full", active ? "flex flex-col" : "hidden")}
						>
							{tb.panes.map((pane, i) => (
								<div key={pane.id} className="group/pane relative flex min-h-0 flex-col" style={{ flexGrow: pane.weight, flexBasis: 0 }}>
									<div
										className="relative min-h-0 flex-1"
										onFocus={() => focusPane(tb.id, pane.id)}
										onMouseDown={() => focusPane(tb.id, pane.id)}
									>
										<Terminal workspace={workspace} ptyPort={ptyPort} visible={active} />
										{tb.panes.length > 1 && (
											<button
												onClick={() => closePane(tb.id, pane.id)}
												className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded bg-surface-2/80 text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover/pane:opacity-100"
												title={t("terminal.closePane")}
											>
												<X className="h-3 w-3" />
											</button>
										)}
									</div>
									{i < tb.panes.length - 1 && (
										<div
											onPointerDown={(e) => onSplitPointerDown(e, tb.id, i)}
											onPointerMove={onSplitPointerMove}
											onPointerUp={onSplitPointerUp}
											className="h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-accent/30"
										/>
									)}
								</div>
							))}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
