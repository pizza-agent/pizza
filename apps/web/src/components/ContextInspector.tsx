import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock, Copy, FileSearch, Pin, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui";
import { getEvents } from "@/lib/transport";
import {
	selectInspectorTab,
	toInspectorEvents,
	type ContextSelection,
	type InspectorEvent,
} from "@/lib/context-inspector";

type Tab = "pins" | "recent" | "path";

function estimateTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

function EventBadge({ type }: { type: string }) {
	return (
		<span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted">
			{type.replace("_", " ")}
		</span>
	);
}

export function ContextInspector({
	open,
	onClose,
	threadId,
}: {
	open: boolean;
	onClose: () => void;
	threadId?: string;
}) {
	const { t } = useTranslation();
	const [tab, setTab] = useState<Tab>("pins");
	const [events, setEvents] = useState<InspectorEvent[]>([]);
	const [pinsEvents, setPinsEvents] = useState<InspectorEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [path, setPath] = useState("");
	const [copied, setCopied] = useState(false);

	const loadEvents = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			// Pins need the whole user-message history, not the recent 1000-event
			// page: early constraints are exactly what GoalPins is meant to keep.
			const [recentRows, userRows] = await Promise.all([
				getEvents({ limit: 1000, sessionScoped: true }),
				getEvents({ eventTypes: ["USER_MESSAGE"], limit: 100000, sessionScoped: true }),
			]);
			setEvents(toInspectorEvents(recentRows, threadId));
			setPinsEvents(toInspectorEvents(userRows, threadId));
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [threadId]);

	useEffect(() => {
		if (!open) return;
		void loadEvents();
	}, [open, loadEvents]);

	const selection: ContextSelection | null = useMemo(
		() => selectInspectorTab(tab, events, pinsEvents, path),
		[tab, events, pinsEvents, path],
	);

	const copyJson = async () => {
		if (!selection) return;
		try {
			await navigator.clipboard.writeText(JSON.stringify(selection, null, 2));
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can be unavailable in non-secure web contexts; the
			// panel remains usable and the JSON is still visible/selectable.
		}
	};

	const tabs: Array<{ id: Tab; label: string; icon: typeof Pin }> = [
		{ id: "pins", label: t("contextInspector.pins"), icon: Pin },
		{ id: "recent", label: t("contextInspector.recent"), icon: Clock },
		{ id: "path", label: t("contextInspector.path"), icon: FileSearch },
	];

	return (
		<Modal open={open} onClose={onClose} title={t("contextInspector.title")} size="lg">
			<div className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex rounded-lg border border-border/70 bg-surface-2/40 p-0.5">
						{tabs.map(({ id, label, icon: Icon }) => (
							<button
								key={id}
								type="button"
								onClick={() => setTab(id)}
								className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
									tab === id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
								}`}
							>
								<Icon className="h-3.5 w-3.5" />
								{label}
							</button>
						))}
					</div>
					<div className="flex items-center gap-2 text-[11px] text-muted">
						{selection && (
							<>
								<span>{t("contextInspector.events", { count: selection.evidence.length })}</span>
								<span>·</span>
								<span>{t("contextInspector.tokens", { count: estimateTokens(selection.markdown) })}</span>
							</>
						)}
						<button
							type="button"
							onClick={() => void loadEvents()}
							disabled={loading}
							className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
							title={t("contextInspector.refresh")}
						>
							<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
						</button>
						<button
							type="button"
							onClick={() => void copyJson()}
							disabled={!selection}
							className="flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-fg hover:bg-surface-2 disabled:opacity-40"
						>
							{copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
							{copied ? t("contextInspector.copied") : t("contextInspector.copy")}
						</button>
					</div>
				</div>

				{tab === "path" && (
					<div className="flex gap-2">
						<input
							value={path}
							onChange={(event) => setPath(event.target.value)}
							placeholder={t("contextInspector.pathPlaceholder")}
							className="min-w-0 flex-1 rounded-md border border-border/70 bg-bg px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
						/>
					</div>
				)}

				<div className="max-h-[55vh] min-h-40 overflow-auto rounded-lg border border-border/70 bg-bg">
					{loading && <div className="p-4 text-xs text-muted">{t("contextInspector.loading")}</div>}
					{error && <div className="p-4 text-xs text-danger">{error}</div>}
					{!loading && !error && !selection && (
						<div className="p-4 text-xs text-muted">
							{tab === "path" ? t("contextInspector.pathHint") : t("contextInspector.empty")}
						</div>
					)}
					{!loading && !error && selection?.evidence.length === 0 && (
						<div className="p-4 text-xs text-muted">{t("contextInspector.empty")}</div>
					)}
					{!loading && !error && selection?.evidence.map((item) => (
						<div key={item.eventId} className="border-b border-border/50 px-3 py-2 last:border-b-0">
							<div className="flex items-center gap-2">
								<EventBadge type={item.type} />
								<span className="min-w-0 flex-1 text-xs text-fg">{item.summary}</span>
							</div>
							<div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
								<span>{t("contextInspector.eventId")}</span>
								<code className="truncate font-mono">{item.eventId}</code>
							</div>
						</div>
					))}
				</div>

				<p className="text-[11px] text-muted">{t("contextInspector.preview")}</p>
			</div>
		</Modal>
	);
}
