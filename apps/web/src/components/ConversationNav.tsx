import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "./Conversation";

/** One marker per user turn; tool traffic must not crowd the navigation. */
export function ConversationNav({ items, itemRefs, anchorRef, onNavigate, renderCount }: {
	items: TimelineItem[];
	itemRefs: RefObject<Map<string, HTMLDivElement>>;
	anchorRef: RefObject<HTMLDivElement>;
	onNavigate: (id: string) => void;
	renderCount: number;
}) {
	const { t } = useTranslation();
	const turns = useMemo(() => {
		const result: { id: string; title: string; summary: string }[] = [];
		for (const item of items) {
			if (item.role === "user" && !item.agentMessage && !item.queued) {
				result.push({ id: item.id, title: item.text.trim() || item.files?.map((file) => file.name).join(", ") || t("conversation.attachment"), summary: "" });
			} else if (item.role === "assistant" && item.text.trim() && result.length) {
				result[result.length - 1].summary = item.text.slice(0, 400);
			}
		}
		return result;
	}, [items, t]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	const navRef = useRef<HTMLElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const [previewTop, setPreviewTop] = useState(0);
	const previewIndex = turns.findIndex((turn) => turn.id === previewId);
	useLayoutEffect(() => {
		if (!previewId) return;
		const nav = navRef.current;
		const card = previewRef.current;
		const button = buttonRefs.current.get(previewId);
		if (!nav || !card || !button) return;
		const position = () => {
			const navRect = nav.getBoundingClientRect();
			const buttonRect = button.getBoundingClientRect();
			const height = card.getBoundingClientRect().height;
			const centered = buttonRect.top + buttonRect.height / 2 - navRect.top - height / 2;
			setPreviewTop(Math.max(12 - navRect.top, Math.min(centered, window.innerHeight - navRect.top - height - 12)));
		};
		position();
		window.addEventListener("resize", position);
		return () => window.removeEventListener("resize", position);
	}, [previewId, turns]);
	useEffect(() => {
		let container = anchorRef.current?.parentElement;
		while (container && !/^(auto|scroll)$/.test(getComputedStyle(container).overflowY)) container = container.parentElement;
		if (!container) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const top = container.getBoundingClientRect().top + 48;
			let id = turns[0]?.id ?? null;
			for (const turn of turns) {
				const el = itemRefs.current?.get(turn.id);
				if (!el) continue;
				if (el.getBoundingClientRect().top > top) break;
				id = turn.id;
			}
			if (container.scrollHeight - container.scrollTop - container.clientHeight <= 160) id = turns[turns.length - 1]?.id ?? null;
			setActiveId(id);
		};
		const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
		container.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(container);
		if (anchorRef.current?.parentElement) observer.observe(anchorRef.current.parentElement);
		schedule();
		return () => { cancelAnimationFrame(frame); container.removeEventListener("scroll", schedule); observer.disconnect(); };
	}, [turns, itemRefs, anchorRef, renderCount]);
	useEffect(() => {
		if (previewId) return;
		const button = activeId ? buttonRefs.current.get(activeId) : null;
		if (button?.parentElement) {
			const list = button.parentElement;
			list.scrollTop = button.offsetTop - list.clientHeight / 2;
		}
	}, [activeId, previewId]);
	if (turns.length <= 3) return null;
	const preview = turns.find((turn) => turn.id === previewId);
	return (
		<div className="pointer-events-none sticky top-1/2 z-20 h-0">
			<nav ref={navRef} aria-label={t("conversation.quickNavigation")} className="pointer-events-auto absolute left-1 -translate-y-1/2 sm:left-3" onMouseLeave={() => setPreviewId(null)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(null); }} onKeyDown={(event) => { if (event.key === "Escape") setPreviewId(null); }}>
				<div className="scrollbar-hide relative max-h-[50vh] overflow-y-auto overscroll-contain py-2" onScroll={() => setPreviewId(null)}>
					{turns.map((turn, index) => (
						<button key={turn.id} ref={(el) => { if (el) buttonRefs.current.set(turn.id, el); else buttonRefs.current.delete(turn.id); }} type="button" aria-label={t("conversation.goToTurn", { number: index + 1, title: turn.title.slice(0, 100) })} aria-current={activeId === turn.id ? "step" : undefined} onMouseEnter={() => setPreviewId(turn.id)} onFocus={() => setPreviewId(turn.id)} aria-describedby={previewId === turn.id ? "conversation-nav-preview" : undefined} onClick={() => onNavigate(turn.id)} className="group flex h-2.5 w-9 items-center rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent">
							<span style={{ width: `${previewIndex >= 0 ? [26, 20, 14, 10][Math.min(Math.abs(index - previewIndex), 3)] : 10}px` }} className={cn("h-[2px] shrink-0 transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none", previewId === turn.id ? "bg-fg" : activeId === turn.id ? "bg-muted/70" : "bg-muted/30")} />
						</button>
					))}
				</div>
				{preview && <div ref={previewRef} id="conversation-nav-preview" style={{ top: previewTop }} className="absolute left-full ml-2 w-[min(360px,calc(100vw-80px))] rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_8px_28px_rgba(0,0,0,0.10)]" role="tooltip">
					<p className="line-clamp-1 break-words text-sm font-semibold text-fg">{preview.title.slice(0, 300)}</p>
					{preview.summary && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{preview.summary}</p>}
				</div>}
			</nav>
		</div>
	);
}
