import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, RefreshCw, Play } from "lucide-react";
import { getEvents, rewindToEvent, subscribeEvents } from "@/lib/transport";
import type { RpcForensicEvent } from "@/lib/types";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui";
import { cn, samePath } from "@/lib/utils";

type Category = "user" | "agent" | "tools" | "reactor" | "session" | "compaction" | "runtime";

interface CategoryStyle {
	label: string;
	dot: string;
	text: string;
}

const REACTOR_TYPES = new Set([
	"AGENT_TURN_REQUESTED",
	"AGENT_TURN_COMPLETED",
	"LLM_CALL_REQUESTED",
	"LLM_CALL_FAILED",
	"TOOL_RESULTS_AGGREGATED",
	"RETRY_SCHEDULED",
	"RETRY_ABORTED",
	"COMPACTION_REQUESTED",
]);

const ERROR_TYPES = new Set(["AGENT_ERROR", "RUNTIME_ERROR", "LLM_CALL_FAILED"]);

function categoryOf(type: string): Category {
	if (REACTOR_TYPES.has(type)) return "reactor";
	if (type.startsWith("USER_")) return "user";
	if (type.startsWith("SESSION_")) return "session";
	if (type.startsWith("COMPACTION_")) return "compaction";
	if (type.startsWith("TOOL_") || type.startsWith("FILE_") || type.startsWith("BASH_") || type === "COMMAND_EXECUTED") return "tools";
	if (type.startsWith("AGENT_") || type.startsWith("INTENT_")) return "agent";
	return "runtime";
}

function isError(e: RpcForensicEvent): boolean {
	if (ERROR_TYPES.has(e.type)) return true;
	const p = e.payload as { is_error?: boolean; any_error?: boolean } | undefined;
	return Boolean(p?.is_error || p?.any_error);
}

function isFileChange(e: RpcForensicEvent): boolean {
	return e.type === "FILE_MUTATION_APPLIED" || e.type === "INTENT_FILE_EDIT";
}

/** Short, human-readable summary derived from an event's payload. */
function summarize(e: RpcForensicEvent): string {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
	const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
	switch (e.type) {
		case "USER_MESSAGE": {
			const c = s("content") ?? "";
			return c.length > 90 ? `"${c.slice(0, 90)}…"` : c ? `"${c}"` : "";
		}
		case "AGENT_TURN_REQUESTED": return `reason=${s("reason") ?? "?"}${n("retry_attempt") != null ? ` attempt=${n("retry_attempt")}` : ""}`;
		case "AGENT_TURN_COMPLETED": return `reason=${s("reason") ?? "?"}`;
		case "LLM_CALL_REQUESTED": return `messages=${n("message_count") ?? "?"}`;
		case "LLM_CALL_FAILED": return `${s("error") ?? "error"} · retryable=${(p.retryable as boolean) ?? false}${n("status_code") != null ? ` (${n("status_code")})` : ""}`;
		case "TOOL_RESULTS_AGGREGATED": return `count=${n("tool_call_count") ?? "?"} any_error=${(p.any_error as boolean) ?? false}`;
		case "RETRY_SCHEDULED": return `attempt ${n("attempt")}/${n("max_attempts")} · delay=${n("delay_ms")}ms`;
		case "RETRY_ABORTED": return `reason=${s("reason") ?? "?"}`;
		case "COMPACTION_REQUESTED": return `reason=${s("reason") ?? "?"} · tokens=${n("token_count") ?? "?"}`;
		case "INTENT_TOOL_CALL":
		case "TOOL_EXECUTION_START":
		case "TOOL_EXECUTION_END": return `${s("tool_name") ?? "tool"}${(p.is_error as boolean) ? " ✗" : ""}`;
		case "FILE_MUTATION_APPLIED": {
			const path = s("path") ?? (p.mutation as { path?: string } | undefined)?.path;
			return `${s("operation") ?? (p.mutation as { operation?: string } | undefined)?.operation ?? "edit"} ${path ?? ""}`.trim();
		}
		case "SESSION_FORKED": return `→ ${s("new_session_id") ?? ""}`;
		case "SESSION_JUMPED": return `→ ${s("target_session_id") ?? ""}`;
		case "SESSION_CREATED": return s("name") ?? s("session_id") ?? "";
		case "MODEL_CHANGED": return `${s("provider") ?? ""}/${s("model_id") ?? ""}`;
		case "AGENT_MESSAGE_END": {
			const content = p.content as Array<{ type?: string; text?: string }> | undefined;
			const text = content?.find((b) => b.type === "text")?.text ?? "";
			return text.length > 90 ? `${text.slice(0, 90)}…` : text || `(${s("stop_reason") ?? "response"})`;
		}
		case "AGENT_ERROR":
		case "RUNTIME_ERROR": return s("error") ?? s("message") ?? "";
		default: return "";
	}
}

function formatClock(ts: number): string {
	try {
		const d = new Date(ts);
		return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
	} catch { return ""; }
}

/**
 * Event Timeline & Replay — DevTools-style raw event stream for the active
 * workspace with reactor-control events surfaced. Click a row to set the
 * cursor; replay forks a new session from that event.
 */
export default function EventTimeline({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [events, setEvents] = useState<RpcForensicEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [cats, setCats] = useState<Set<Category>>(new Set());
	const [errorsOnly, setErrorsOnly] = useState(false);
	const [filesOnly, setFilesOnly] = useState(false);
	const [cursor, setCursor] = useState<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			setError("");
			setEvents(await getEvents({ limit: 2000, sessionScoped: true }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		setLoading(true);
		setEvents([]);
		setCursor(null);
		void load();
	}, [workspace, load]);

	// Live-append on new events for the active workspace (debounced reload).
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unlistenP = subscribeEvents((event) => {
			const typed = event as { _cwd?: string };
			if (typed._cwd && workspace && !samePath(typed._cwd, workspace)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => { if (!cancelled) void load(); }, 400);
		});
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			unlistenP.then((fn) => fn()).catch(() => {});
		};
	}, [workspace, load]);

	const catStyles: Record<Category, CategoryStyle> = useMemo(() => ({
		user: { label: t("timeline.catUser"), dot: "bg-accent", text: "text-accent" },
		agent: { label: t("timeline.catAgent"), dot: "bg-success", text: "text-success" },
		tools: { label: t("timeline.catTools"), dot: "bg-muted", text: "text-fg" },
		reactor: { label: t("timeline.catReactor"), dot: "bg-violet-400", text: "text-violet-400" },
		session: { label: t("timeline.catSession"), dot: "bg-warning", text: "text-warning" },
		compaction: { label: t("timeline.catCompaction"), dot: "bg-warning", text: "text-warning" },
		runtime: { label: t("timeline.catRuntime"), dot: "bg-muted", text: "text-muted" },
	}), [t]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return events.filter((e) => {
			if (cats.size > 0 && !cats.has(categoryOf(e.type))) return false;
			if (errorsOnly && !isError(e)) return false;
			if (filesOnly && !isFileChange(e)) return false;
			if (q && !e.type.toLowerCase().includes(q) && !summarize(e).toLowerCase().includes(q)) return false;
			return true;
		});
	}, [events, cats, errorsOnly, filesOnly, query]);

	const toggleCat = (c: Category) => setCats((prev) => {
		const next = new Set(prev);
		if (next.has(c)) next.delete(c); else next.add(c);
		return next;
	});

	const cursorEvent = events.find((e) => e.event_id === cursor);
	const onReplay = useCallback(async () => {
		if (!cursor) return;
		try { await rewindToEvent(cursor); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [cursor]);

	const filterChips: Category[] = ["user", "agent", "tools", "reactor", "session", "compaction"];

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="relative flex-1">
						<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("timeline.search")}
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
				<div className="flex flex-wrap items-center gap-1">
					{filterChips.map((c) => (
						<button
							key={c}
							onClick={() => toggleCat(c)}
							className={cn(
								"flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
								cats.has(c)
									? "border-accent bg-accent/10 text-accent"
									: "border-border text-muted hover:text-fg",
							)}
						>
							<span className={cn("h-1.5 w-1.5 rounded-full", catStyles[c].dot)} />
							{catStyles[c].label}
						</button>
					))}
					<button
						onClick={() => setErrorsOnly((v) => !v)}
						className={cn(
							"rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
							errorsOnly ? "border-danger bg-danger/10 text-danger" : "border-border text-muted hover:text-fg",
						)}
					>
						{t("timeline.errorsOnly")}
					</button>
					<button
						onClick={() => setFilesOnly((v) => !v)}
						className={cn(
							"rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
							filesOnly ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-fg",
						)}
					>
						{t("timeline.filesOnly")}
					</button>
				</div>
			</div>

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Event stream */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : filtered.length === 0 ? (
					<div className="p-4">
						<EmptyState title={t("timeline.emptyTitle")} description={t("timeline.emptyDescription")} />
					</div>
				) : (
					<ul className="font-mono text-[11px]">
						{filtered.map((e) => {
							const cat = categoryOf(e.type);
							const style = catStyles[cat];
							const err = isError(e);
							return (
								<li key={e.event_id}>
									<button
										onClick={() => setCursor(e.event_id)}
										className={cn(
											"flex w-full items-start gap-2 border-l-2 px-3 py-1 text-left transition-colors hover:bg-surface-2",
											cursor === e.event_id ? "border-accent bg-accent/10" : "border-transparent",
										)}
									>
										<span className="w-20 shrink-0 tabular-nums text-muted">{formatClock(e.timestamp)}</span>
										<span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", err ? "bg-danger" : style.dot)} />
										<span className={cn("w-52 shrink-0 truncate", err ? "text-danger" : style.text)}>{e.type}</span>
										<span className="min-w-0 flex-1 truncate text-muted">{summarize(e)}</span>
									</button>
								</li>
							);
						})}
						<div ref={bottomRef} />
					</ul>
				)}
			</div>

			{/* Cursor detail */}
			{cursorEvent && (
				<div className="max-h-56 shrink-0 overflow-y-auto border-t border-border bg-surface-2 p-3">
					<div className="mb-2 flex items-center justify-between">
						<div className="font-mono text-[11px] text-fg">
							<span className={catStyles[categoryOf(cursorEvent.type)].text}>{cursorEvent.type}</span>
							<span className="ml-2 text-muted">{cursorEvent.event_id}</span>
						</div>
						<button
							onClick={() => void onReplay()}
							className="flex items-center gap-1 rounded-md border border-accent px-2 py-1 font-mono text-[10px] text-accent transition-colors hover:bg-accent/10"
							title={t("timeline.replayHint")}
						>
							<Play className="h-3 w-3" />
							{t("timeline.replayFromHere")}
						</button>
					</div>
					<pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted">
						{JSON.stringify(cursorEvent.payload, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
