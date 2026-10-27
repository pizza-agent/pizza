import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, ChevronRight, FileText, PenLine, RefreshCw, Search, UserRound } from "lucide-react";
import { MainDocumentEditor } from "@/components/MainDocumentEditor";
import { Markdown } from "@/components/Markdown";
import { PET_SETTINGS_PATH } from "@/lib/pet";
import { PetFigure } from "@/components/PetFigure";
import { Spinner } from "@/components/ui";
import { getMainDocument, getMainJournals, type MainAgentDocument, type MainAgentProfileState, type MainJournalPage } from "@/lib/main-agent-profile";
import { prefillComposer } from "@/lib/composer-prefill";
import { cn } from "@/lib/utils";

type Page = "overview" | "memories" | "journal";

export default function MainAgentView({ workspace, data, running, connected }: {
	workspace: string;
	data: MainAgentProfileState;
	running: boolean;
	connected: boolean;
}) {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const { profile, error, loading, refresh, pet: petState } = data;
	const { pet } = petState;
	const [page, setPage] = useState<Page>("overview");
	const [query, setQuery] = useState("");
	const [sourceId, setSourceId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [document, setDocument] = useState<MainAgentDocument | null>(null);
	const [documentError, setDocumentError] = useState("");
	const [documentLoading, setDocumentLoading] = useState(false);
	const [documentVersion, setDocumentVersion] = useState(0);
	const [journal, setJournal] = useState<MainJournalPage>({ entries: [] });
	const [journalLoading, setJournalLoading] = useState(false);
	const [journalError, setJournalError] = useState("");
	const scroll = useRef<HTMLDivElement>(null);
	const savedScroll = useRef(0);
	const journalGeneration = useRef(0);
	useEffect(() => {
		setJournal(profile?.journal ?? { entries: [] });
		journalGeneration.current++;
		setJournalLoading(false); setJournalError("");
	}, [profile?.journal]);
	useEffect(() => () => { journalGeneration.current++; }, []);
	useEffect(() => {
		let cancelled = false;
		setDocument(null); setDocumentError("");
		if (!sourceId) return;
		setDocumentLoading(true);
		void getMainDocument(sourceId).then((result) => {
			if (!cancelled) setDocument(result);
		}).catch((e) => { if (!cancelled) setDocumentError(String(e)); })
			.finally(() => { if (!cancelled) setDocumentLoading(false); });
		return () => { cancelled = true; };
	}, [sourceId, workspace, documentVersion]);
	useEffect(() => {
		if (!sourceId || editingId) return;
		const focus = () => { setDocumentVersion((value) => value + 1); };
		window.addEventListener("focus", focus);
		return () => window.removeEventListener("focus", focus);
	}, [sourceId, editingId]);
	const open = (id: string) => {
		savedScroll.current = scroll.current?.scrollTop ?? 0;
		setSourceId(id); setEditingId(null);
		if (scroll.current) scroll.current.scrollTop = 0;
	};
	const back = () => {
		setSourceId(null); setEditingId(null);
		requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = savedScroll.current; });
	};
	const editor = (id: string, label: string) => <MainDocumentEditor key={`${workspace}:${id}`} workspace={workspace} sourceId={id} label={label}
		onCommitted={() => { void refresh(); }} onCancel={() => setEditingId(null)} onSaved={(saved) => { setEditingId(null); if (sourceId === id) setDocument(saved); }} />;

	const moreJournal = async () => {
		if (!journal.nextBefore || journalLoading) return;
		const request = ++journalGeneration.current;
		setJournalLoading(true); setJournalError("");
		try {
			const next = await getMainJournals(journal.nextBefore);
			if (request === journalGeneration.current) setJournal((old) => ({ entries: [...old.entries, ...next.entries], nextBefore: next.nextBefore }));
		} catch (e) { if (request === journalGeneration.current) setJournalError(String(e)); }
		finally { if (request === journalGeneration.current) setJournalLoading(false); }
	};
	const name = profile?.soul.name || t("layout.agent");
	const species = pet?.speciesId ?? (petState.loaded ? undefined : profile?.pet?.speciesId);
	const editAppearance = t("mainAgent.editAppearance");
	const avatar = <div className="group/avatar relative h-12 w-12 shrink-0">
		<button type="button" onClick={() => navigate(PET_SETTINGS_PATH)} aria-label={editAppearance} title={editAppearance}
			className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-surface-2/60 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">
			<PetFigure species={species} mood={running ? "working" : pet?.mood ?? "idle"} busy={running} size={44} frames={petState.species?.frames} halo={false} />
		</button>
		<span aria-hidden="true" className="pointer-events-none absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-surface bg-fg text-bg shadow-sm transition-transform group-hover/avatar:scale-110">
			<PenLine className="h-2.5 w-2.5" strokeWidth={2.2} />
		</span>
	</div>;
	const action = "inline-flex items-center gap-1 rounded text-[11px] text-muted transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent";
	const sectionTitle = (label: string, target?: Page, editableSource?: string) => <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-fg">{label}</h3>{editableSource && editingId !== editableSource && <button className={action} aria-label={`${t("mainAgent.edit")} ${label}`} onClick={() => setEditingId(editableSource)}><PenLine className="h-3 w-3" />{t("mainAgent.edit")}</button>}{target && <button className={action} onClick={() => { setPage(target); if (scroll.current) scroll.current.scrollTop = 0; }}>{t("mainAgent.viewAll")}<ArrowRight className="h-3 w-3" /></button>}</div>;
	const empty = (text: string, prompt: string) => <div className="rounded-xl border border-dashed border-border px-4 py-4 text-xs leading-relaxed text-muted"><p>{text}</p><button className={cn(action, "mt-3 text-accent")} onClick={() => prefillComposer(workspace, prompt)}>{t("mainAgent.startInChat")}<ArrowRight className="h-3 w-3" /></button></div>;
	const memories = (profile?.memories ?? []).filter((entry) => `${entry.title} ${entry.summary} ${entry.sourceId}`.toLowerCase().includes(query.toLowerCase()));
	const memoryRows = (items: typeof memories) => items.map((entry) => <button key={entry.sourceId} disabled={entry.status === "stale" || entry.status === "unavailable"} onClick={() => open(entry.sourceId)} className="group flex w-full items-start gap-3 border-b border-border/60 py-3.5 text-left last:border-b-0 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60">
		<FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={1.5} /><span className="min-w-0 flex-1"><span className="block break-words text-xs font-medium">{entry.title}</span>{entry.summary && <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted">{entry.summary}</span>}{entry.status !== "indexed" && <span className="mt-1 block text-[10px] text-muted">{t(`mainAgent.memoryStatus.${entry.status}`)}</span>}</span><ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted/60" />
	</button>);
	const renderJournal = (entries: MainJournalPage["entries"]) => entries.map((entry) => <button key={entry.sourceId} onClick={() => open(entry.sourceId)} className="block w-full rounded-lg py-3 text-left hover:bg-surface-2/40">
		<span className="text-[10px] tabular-nums text-muted">{new Date(`${entry.date}T12:00:00`).toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" })}</span>
		<span className="mt-1.5 block text-xs font-medium">{entry.title}</span><span className="mt-1.5 line-clamp-3 block text-[11px] leading-relaxed text-muted">{entry.preview}</span>
	</button>);
	return (
		<div className="flex h-full min-w-0 flex-col bg-surface" data-main-agent-profile>
			<div className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-5 py-2">
				{sourceId || page !== "overview" ? <button className={cn(action, "text-xs")} onClick={() => sourceId ? back() : setPage("overview")}><ArrowLeft className="h-3.5 w-3.5" />{t("mainAgent.back")}</button> : <h2 className="text-sm font-semibold">{t("mainAgent.profileTitle")}</h2>}
				<button className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent" aria-label={t("mainAgent.refresh")} title={t("mainAgent.refresh")} onClick={() => { void refresh(); if (sourceId) setDocumentVersion((v) => v + 1); }}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin motion-reduce:animate-none")} /></button>
			</div>
			{error && <div role="alert" className="mx-5 mb-3 rounded-lg border border-danger/20 bg-danger/5 p-3 text-[11px] text-danger"><p>{t("mainAgent.loadError")}</p><p className="mt-1 break-words opacity-80">{error}</p><button className="mt-2 underline" onClick={() => { void refresh(); }}>{t("mainAgent.retry")}</button></div>}
			<div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
				{sourceId ? <div>
					<div className="mb-4 flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-all text-[10px] text-muted">{sourceId}</span>{document && editingId !== sourceId && <button className={action} onClick={() => setEditingId(sourceId)}><PenLine className="h-3 w-3" />{t("mainAgent.edit")}</button>}</div>
					{editingId === sourceId ? editor(sourceId, t("mainAgent.documentContent")) : documentLoading ? <div className="flex justify-center py-10"><Spinner /></div> : documentError ? <div role="alert" className="break-words text-xs text-danger">{documentError}<button className="ml-2 underline" onClick={() => setDocumentVersion((v) => v + 1)}>{t("mainAgent.retry")}</button></div> : document && <div className="break-words text-xs"><Markdown>{document.content}</Markdown></div>}
				</div> : !profile ? loading ? <div aria-label={t("mainAgent.loading")} className="animate-pulse space-y-6 motion-reduce:animate-none"><div className="h-20 rounded-xl bg-surface-2" /><div className="h-32 rounded-xl bg-surface-2" /><div className="h-40 rounded-xl bg-surface-2" /></div> : null : page === "memories" ? <div>
					<h3 className="mb-4 text-sm font-semibold">{t("mainAgent.memories")}</h3><label className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-bg px-3"><Search className="h-3.5 w-3.5 text-muted" /><input className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("mainAgent.searchMemories")} aria-label={t("mainAgent.searchMemories")} /></label>
					{memories.length ? memoryRows(memories) : <p className="py-6 text-xs text-muted">{t(query ? "mainAgent.noMatches" : "mainAgent.noMemories")}</p>}{profile.memoriesTruncated && <p className="mt-3 text-[11px] text-muted">{t("mainAgent.memoryLimit")}</p>}
				</div> : page === "journal" ? <div>
					<h3 className="mb-3 text-sm font-semibold">{t("mainAgent.journal")}</h3>{journal.entries.length ? renderJournal(journal.entries) : empty(t("mainAgent.noJournal"), t("mainAgent.journalPrompt"))}
					{journalError && <p role="alert" className="my-2 text-xs text-danger">{journalError}</p>}{journal.nextBefore && <button className={cn(action, "mt-4")} disabled={journalLoading} onClick={() => { void moreJournal(); }}>{t(journalLoading ? "mainAgent.loading" : "mainAgent.loadMore")}</button>}
				</div> : <>
					<section className="flex items-center gap-3 pb-5 pt-1">{avatar}<div className="min-w-0"><h3 className="truncate text-lg font-semibold">{name}</h3><p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted"><span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-success" : "bg-muted")} />{t(!connected ? "mainAgent.disconnected" : running ? "mainAgent.working" : "mainAgent.idle")}<span className="text-border">·</span>{t("layout.agentSubtitle")}</p></div></section>
					<section className="border-t border-border py-5">
						{sectionTitle(t("mainAgent.identity"), undefined, profile.soul.sourceId)}
						{editingId === profile.soul.sourceId ? editor(profile.soul.sourceId, t("mainAgent.identity")) : profile.soul.initialized ? <p className="whitespace-pre-line text-xs leading-relaxed text-fg/80">{profile.soul.summary}</p> : empty(t("mainAgent.noSoul"), t("mainAgent.soulPrompt"))}
					</section>
					<section className="border-t border-border py-5">
						{sectionTitle(t("mainAgent.aboutYou"), undefined, profile.userProfile?.sourceId)}
						{editingId === profile.userProfile?.sourceId ? editor(editingId!, t("mainAgent.aboutYou")) : <><div className="mb-3 flex items-center gap-2 text-[11px] text-muted"><UserRound className="h-3.5 w-3.5" />{t("mainAgent.preferencesHint")}</div>{profile.userProfile?.summary ? <p className="line-clamp-5 whitespace-pre-line text-xs leading-relaxed text-fg/80">{profile.userProfile.summary}</p> : empty(t("mainAgent.noPreferences"), t("mainAgent.preferencesPrompt"))}</>}
					</section>
					<section className="border-t border-border py-5">{sectionTitle(t("mainAgent.memories"), "memories")}{profile.memories.length ? memoryRows(profile.memories.slice(0, 3)) : empty(t("mainAgent.noMemories"), t("mainAgent.preferencesPrompt"))}<p className="mt-2 text-[10px] leading-relaxed text-muted">{t("mainAgent.memoryHint")}</p></section>
					<section className="border-t border-border py-5">{sectionTitle(t("mainAgent.recentJournal"), "journal")}{profile.journal.entries.length ? renderJournal(profile.journal.entries.slice(0, 1)) : empty(t("mainAgent.noJournal"), t("mainAgent.journalPrompt"))}</section>
				</>}
			</div>
		</div>
	);
}
