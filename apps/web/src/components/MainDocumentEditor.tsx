import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2 } from "lucide-react";
import { getMainDocument, saveMainDocument, type MainAgentDocument } from "@/lib/main-agent-profile";
import { mainAgentDraftKey, mainAgentDrafts } from "@/lib/main-agent-drafts";
import { cn } from "@/lib/utils";

/** Edits the complete source, preserving headings/frontmatter instead of
 * round-tripping a guessed schema. Saves require the loaded content revision. */
export function MainDocumentEditor({ workspace, sourceId, label, onSaved, onCancel, onCommitted }: {
	workspace: string;
	sourceId: string;
	label: string;
	onSaved: (document: MainAgentDocument) => void;
	onCancel: () => void;
	onCommitted?: () => void;
}) {
	const { t } = useTranslation();
	const key = mainAgentDraftKey(workspace, sourceId);
	const cached = useRef(mainAgentDrafts.get(key));
	const [document, setDocument] = useState<MainAgentDocument | null>(cached.current?.document ?? null);
	const [content, setContent] = useState(cached.current?.content ?? "");
	const [loading, setLoading] = useState(!cached.current);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState(false);
	const [copied, setCopied] = useState(false);
	const [reload, setReload] = useState(0);
	const mounted = useRef(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => {
		let cancelled = false;
		if (cached.current && reload === 0) return;
		setLoading(true); setError(""); setConflict(false);
		void getMainDocument(sourceId).then((result) => {
			if (!cancelled) { setDocument(result); setContent(result.content); }
		}).catch((e) => { if (!cancelled) setError(String(e)); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [sourceId, reload]);
	useEffect(() => { if (document && !loading) textarea.current?.focus(); }, [document, loading]);
	const save = async () => {
		if (!document || content === document.content || saving || loading || conflict) return;
		setSaving(true); setError("");
		try {
			const saved = await saveMainDocument(sourceId, content, document.revision);
			mainAgentDrafts.delete(key);
			onCommitted?.();
			if (mounted.current) onSaved(saved);
		} catch (e) {
			if (mounted.current) {
				const message = String(e);
				setConflict(message.includes("DOCUMENT_CONFLICT"));
				setError(message.includes("DOCUMENT_CONFLICT") ? t("mainAgent.conflict") : message);
			}
		} finally { if (mounted.current) setSaving(false); }
	};
	const button = "rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
	return (
		<div className="space-y-3" data-main-document-editor={sourceId}>
			{loading ? <p role="status" className="flex items-center gap-2 py-4 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("mainAgent.loading")}</p> : document && <>
				<textarea ref={textarea} value={content} onChange={(event) => {
					const next = event.target.value;
					setContent(next); setCopied(false);
					if (next === document.content) mainAgentDrafts.delete(key);
					else mainAgentDrafts.set(key, { document, content: next });
				}} onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
				}} disabled={saving} aria-label={label} rows={10} spellCheck={false}
					className="block min-h-40 max-h-[55dvh] w-full resize-y rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:opacity-70" />
				<p className="text-[10px] leading-relaxed text-muted">{t("mainAgent.editorHint")}</p>
			</>}
			{error && <p role="alert" className="break-words text-xs leading-relaxed text-danger">{error}</p>}
			{conflict && <div className="flex flex-wrap gap-2">
				<button className={cn(button, "border border-border text-muted")} onClick={() => { void navigator.clipboard.writeText(content).then(() => setCopied(true)).catch((e) => setError(String(e))); }}>{copied ? <Check className="mr-1 inline h-3 w-3" /> : <Copy className="mr-1 inline h-3 w-3" />}{t(copied ? "common.copied" : "mainAgent.copyDraft")}</button>
				<button className={cn(button, "text-muted hover:bg-surface-2")} title={t("mainAgent.reloadHint")} onClick={() => { mainAgentDrafts.delete(key); cached.current = undefined; setReload((value) => value + 1); }}>{t("mainAgent.reloadSource")}</button>
			</div>}
			<div className="flex items-center justify-end gap-2">
				<button className={cn(button, "text-muted hover:bg-surface-2")} disabled={saving} onClick={() => { mainAgentDrafts.delete(key); onCancel(); }}>{t("mainAgent.cancel")}</button>
				{!document && !loading ? <button className={cn(button, "bg-accent text-accent-fg")} onClick={() => setReload((value) => value + 1)}>{t("mainAgent.retry")}</button> : <button className={cn(button, "bg-accent text-accent-fg")} disabled={!document || loading || saving || conflict || content === document.content} onClick={() => { void save(); }}>{saving && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}{t(saving ? "mainAgent.saving" : "mainAgent.save")}</button>}
			</div>
		</div>
	);
}
