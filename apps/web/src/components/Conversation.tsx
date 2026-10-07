import { memo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { highlightText } from "@/lib/highlight";
import { parseTellCommand, workspaceNameFrom, type AgentMessageInfo } from "@/lib/agent-messages";
import { Markdown } from "./Markdown";
import { Button, Badge } from "@/components/ui";
import { FileAttachmentIcon } from "@/components/FileAttachmentIcon";
import { formatFileSize } from "@/lib/file-format";
import {
	Terminal,
	ChevronRight,
	Copy,
	Check,
	ThumbsUp,
	ThumbsDown,
	Brain,
	Loader2,
	AlertCircle,
	ShieldAlert,
	Waypoints,
	ArrowUpRight,
} from "lucide-react";

export interface TimelineItem {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	title: string;
	text: string;
	status: string;
	streaming?: boolean;
	/** Accumulated reasoning/thinking text (assistant messages). */
	thinking?: string;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	/** Images returned by the tool (data URLs), rendered as thumbnails. */
	toolImages?: string[];
	isError?: boolean;
	/** Attached images as data URLs (for user messages). */
	images?: string[];

	/** Attached file path references (for user messages). */
	files?: Array<{ absolutePath: string; mimeType: string; name: string; size: number }>;
	/** True for a follow-up message queued while the agent is still running. */
	queued?: boolean;
	/** Pending approval for a risky tool call (safe mode on). */
	pendingApproval?: {
		intentEventId: string;
		risk?: string;
		category?: string;
		description?: string;
		affectedFiles?: string[];
		status: "pending" | "approved" | "rejected";
	};
	/** Unix ms timestamp when the message was emitted. */
	timestamp?: number;
	/** Parsed cross-workspace agent message (rendered as a dedicated card). */
	agentMessage?: AgentMessageInfo;
	/** True when the raw text carries the gateway trust trailer (footnote). */
	gatewayTrailer?: boolean;
}

/** True if two Unix ms timestamps fall on the same calendar day (local time). */
function isSameDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return (
		da.getFullYear() === db.getFullYear() &&
		da.getMonth() === db.getMonth() &&
		da.getDate() === db.getDate()
	);
}

/**
 * Format a Unix ms timestamp for message timestamps.
 * Today: HH:mm; other days: MM-DD HH:mm (with year if a different year).
 * Returns "" if invalid.
 */
function formatMessageTime(ts?: number): string {
	if (!ts || !Number.isFinite(ts)) return "";
	try {
		const d = new Date(ts);
		const time = d.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		if (isSameDay(ts, Date.now())) return time;
		const sameYear = d.getFullYear() === new Date().getFullYear();
		const date = d.toLocaleDateString(undefined, {
			year: sameYear ? undefined : "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		return `${date} ${time}`;
	} catch {
		return "";
	}
}

const COLLAPSE_LINES = 5;

/** Rendering caps for tool output/args: protect the DOM from huge payloads
 * (base64 images, minified JSON) that can arrive as a single enormous line. */
const MAX_PREVIEW_LINE_CHARS = 240;
const MAX_PREVIEW_TOTAL_CHARS = 1500;
const MAX_EXPANDED_LINE_CHARS = 4000;

/** Clamp text for display: cap the number of lines in the collapsed preview
 * and the length of every line in either state. Returns the text to render
 * plus whether anything was cut (a "show more" affordance is then shown). */
function clampForDisplay(text: string, expanded: boolean): { shown: string; clamped: boolean } {
	const lines = text.split("\n");
	const lineCap = expanded ? MAX_EXPANDED_LINE_CHARS : MAX_PREVIEW_LINE_CHARS;
	const maxLines = expanded ? lines.length : COLLAPSE_LINES;
	const out: string[] = [];
	let total = 0;
	let clamped = false;
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		let line = lines[i]!;
		if (lineCap < line.length) {
			line = `${line.slice(0, lineCap)} …[+${line.length - lineCap} chars]`;
			clamped = true;
		}
		if (!expanded && MAX_PREVIEW_TOTAL_CHARS < total + line.length) {
			clamped = true;
			break;
		}
		out.push(line);
		total += line.length;
	}
	if (out.length < lines.length) clamped = true;
	return { shown: out.join("\n"), clamped };
}

function useCopy(): [boolean, (text: string) => void] {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Clear the pending reset on unmount so we never set state on a dead component.
	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);
	const copy = (text: string) => {
		void navigator.clipboard.writeText(text);
		setCopied(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), 1500);
	};
	return [copied, copy];
}

/** Long monospace block that collapses to a preview by default. */
function CollapsibleCode({ text, isError, highlight, highlightActive }: { text: string; isError?: boolean; highlight?: string; highlightActive?: boolean }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const { shown, clamped } = clampForDisplay(text, expanded);
	return (
		<div className="relative">
			<pre
				className={cn(
					"overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2/40 px-3 py-2 font-mono text-xs leading-relaxed",
					isError ? "text-danger" : "text-muted",
				)}
			>
				{highlight ? highlightText(shown, highlight, highlightActive) : shown}
				{clamped && !expanded && <span className="text-muted/60">{"\n…"}</span>}
			</pre>
			{clamped && (
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					className="mt-1 text-[11px] text-muted transition-colors hover:text-fg"
				>
					{expanded ? t("conversation.showLess") : t("conversation.showMore")}
				</button>
			)}
		</div>
	);
}

/** Collapsible reasoning/thinking block, collapsed by default. */
function Thinking({ text, streaming, highlight, highlightActive }: { text: string; streaming?: boolean; highlight?: string; highlightActive?: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	return (
		<div className="mb-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-fg"
			>
				<Brain className={cn("h-3.5 w-3.5", streaming && "animate-pulse")} />
				<span>{streaming ? t("conversation.thinking") : t("conversation.thoughtProcess")}</span>
				<ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
			</button>
			{open && (
				<div className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted">
					<div className="whitespace-pre-wrap break-words">{highlight ? highlightText(text, highlight, highlightActive) : text}</div>
				</div>
			)}
		</div>
	);
}

function formatToolArgs(toolArgs?: string): string {
	if (!toolArgs) return "";
	try {
		const obj = JSON.parse(toolArgs);
		if (obj && typeof obj === "object" && typeof obj.command === "string") {
			return obj.command;
		}
		return JSON.stringify(obj, null, 2);
	} catch {
		return toolArgs;
	}
}

function approvalRiskTone(risk?: string): "neutral" | "warning" | "danger" {
	switch (risk) {
		case "dangerous":
			return "danger";
		case "moderate":
			return "warning";
		default:
			return "neutral";
	}
}

/** Inline approval card rendered inside a tool card when safe mode pauses a risky call. */
function ApprovalSection({
	approval,
	onResolve,
}: {
	approval: NonNullable<TimelineItem["pendingApproval"]>;
	onResolve?: (approved: boolean) => void;
}) {
	const { t } = useTranslation();
	const pending = approval.status === "pending";
	return (
		<div className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-2">
				<ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
				<span className="text-xs font-semibold text-warning">
					{t("approval.title")}
				</span>
				{approval.risk && (
					<Badge tone={approvalRiskTone(approval.risk)}>
						{t("approval.riskPrefix")} {approval.risk}
					</Badge>
				)}
				{approval.category && <Badge tone="neutral">{approval.category}</Badge>}
			</div>
			{approval.description && (
				<p className="mt-1.5 text-xs leading-relaxed text-muted">{approval.description}</p>
			)}
			{approval.affectedFiles && approval.affectedFiles.length > 0 && (
				<div className="mt-1.5 flex flex-col gap-0.5">
					{approval.affectedFiles.map((f) => (
						<code key={f} className="block truncate font-mono text-[11px] text-fg" title={f}>
							{f}
						</code>
					))}
				</div>
			)}
			{pending && onResolve ? (
				<div className="mt-2.5 flex items-center gap-2">
					<Button
						size="sm"
						tone="danger"
						variant="soft"
						onClick={() => onResolve(false)}
					>
						{t("approval.reject")}
					</Button>
					<Button size="sm" tone="accent" variant="solid" onClick={() => onResolve(true)}>
						{t("approval.approve")}
					</Button>
				</div>
			) : approval.status === "approved" ? (
				<span className="mt-1.5 block text-[11px] font-medium text-success">
					{t("approval.approved")}
				</span>
			) : approval.status === "rejected" ? (
				<span className="mt-1.5 block text-[11px] font-medium text-danger">
					{t("approval.rejected")}
				</span>
			) : null}
		</div>
	);
}

/** Thumbnail for an image returned by a tool. Click to open full size. */
function ToolImage({ src, index, count }: { src: string; index: number; count: number }) {
	const [zoom, setZoom] = useState(false);
	return (
		<>
			<button
				type="button"
				onClick={() => setZoom(true)}
				className="group relative overflow-hidden rounded-md border border-border"
				title="🔍"
			>
				<img src={src} alt={`tool image ${index + 1}/${count}`} className="max-h-40 object-contain transition-transform group-hover:scale-[1.02]" />
			</button>
			{zoom && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
					onClick={() => setZoom(false)}
				>
					<img src={src} alt={`tool image ${index + 1}/${count}`} className="max-h-full max-w-full rounded-md object-contain" />
					<button
						type="button"
						className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
						onClick={() => setZoom(false)}
					>
						✕
					</button>
				</div>
			)}
		</>
	);
}

const ToolCard = memo(function ToolCard({
	item,
	onResolveApproval,
	highlight,
	highlightActive,
}: {
	item: TimelineItem;
	onResolveApproval?: (intentEventId: string, toolCallId: string, approved: boolean) => void;
	highlight?: string;
	highlightActive?: boolean;
}) {
	const { t } = useTranslation();
	const [argsExpanded, setArgsExpanded] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [copied, copy] = useCopy();
	const command = formatToolArgs(item.toolArgs);
	// Routed `_tell` commands get a dedicated header ("tell → <workspace>") so
	// cross-workspace traffic reads as messaging, not as a raw shell call.
	const tellInfo = item.toolName === "cli" ? parseTellCommand(command) : null;
	const tellToName = tellInfo?.to ? workspaceNameFrom(tellInfo.to) : undefined;
	const { shown: commandShown, clamped: commandClamped } = clampForDisplay(command, argsExpanded);
	const running = item.streaming && !item.toolResult;
	const approval = item.pendingApproval;
	const awaitingApproval = approval?.status === "pending";
	// Tool name + title are matched by search too; highlight them when active.
	const toolTitle = highlight ? highlightText(item.toolName || item.title, highlight, highlightActive) : (item.toolName || item.title);
	const hasBody = !!(
		(command && (!collapsed || commandClamped)) ||
		approval ||
		(item.toolImages && item.toolImages.length > 0) ||
		item.toolResult ||
		(running && !item.toolResult)
	);
	return (
		<div className="my-4 flex justify-start">
			<div
				className={cn(
					"w-full max-w-full overflow-hidden rounded-2xl border",
					item.isError ? "border-danger/30 bg-danger/[0.03]" : awaitingApproval ? "border-warning/40 bg-warning/[0.03]" : "border-border/70 bg-surface",
				)}
			>
				<div
					className={cn(
						"flex items-center justify-between gap-3 px-3.5 py-2.5",
						hasBody && "cursor-pointer select-none",
					)}
					onClick={() => hasBody && setCollapsed((c) => !c)}
				>
					<span className="flex items-center gap-2 text-[13px] font-medium text-fg">
						{tellInfo ? (
							<>
								<Waypoints className="h-3.5 w-3.5 shrink-0 text-muted" />
								<span>
									{tellInfo.action === "list"
										? t("conversation.tell.list")
										: (
											<>
												{t("conversation.tell.send")}
												{tellToName && (
													<span className="ml-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 font-normal text-muted" title={tellInfo.to}>
														{highlight ? highlightText(tellToName, highlight, highlightActive) : tellToName}
													</span>
												)}
											</>
										)}
								</span>
							</>
						) : (
							<>
								{awaitingApproval ? (
									<ShieldAlert className="h-3.5 w-3.5 text-warning" />
								) : (
									<Terminal className="h-3.5 w-3.5 text-muted" />
								)}
								{toolTitle}
							</>
						)}
					</span>
					<span className="flex shrink-0 items-center gap-1">
						<span
							className={cn(
								"flex items-center gap-1 text-[11px]",
								item.isError ? "text-danger" : awaitingApproval ? "text-warning" : running ? "text-muted" : "text-muted/70",
							)}
						>
							{running && <Loader2 className="h-3 w-3 animate-spin" />}
							{item.isError && <AlertCircle className="h-3 w-3" />}
							{item.status}
						</span>
						{(command || item.toolResult) && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									copy(item.toolResult || command || "");
								}}
								className="flex h-6 w-6 items-center justify-center rounded-md text-muted/70 transition-colors hover:bg-surface-2 hover:text-fg"
								title={t("common.copy")}
							>
								{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
							</button>
						)}
						{hasBody && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setCollapsed((c) => !c);
								}}
								className="flex h-6 w-6 items-center justify-center rounded-md text-muted/70 transition-colors hover:bg-surface-2 hover:text-fg"
								title={collapsed ? t("conversation.showMore") : t("conversation.showLess")}
							>
								<ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")} />
							</button>
						)}
					</span>
				</div>
				{!collapsed && (
					<div className="space-y-2 px-3.5 pb-3">
						{command && (
							<div className="font-mono text-xs leading-relaxed text-fg/90">
								<span className="whitespace-pre-wrap break-words">{highlight ? highlightText(commandShown, highlight, highlightActive) : commandShown}</span>
								{commandClamped && (
									<button
										type="button"
										onClick={() => setArgsExpanded((e) => !e)}
										className="mt-1 block text-[11px] text-muted transition-colors hover:text-fg"
									>
										{argsExpanded ? t("conversation.showLess") : t("conversation.showMore")}
									</button>
								)}
							</div>
						)}
						{approval && (
							<ApprovalSection
								approval={approval}
								onResolve={
									onResolveApproval
										? (approved) => onResolveApproval(approval.intentEventId, item.id, approved)
										: undefined
								}
							/>
						)}
						{item.toolImages && item.toolImages.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{item.toolImages.map((src, i) => (
									<ToolImage key={i} src={src} index={i} count={item.toolImages!.length} />
								))}
							</div>
						)}
						{item.toolResult && (
							<div className="border-t border-border/60 pt-2">
								<CollapsibleCode text={item.toolResult} isError={item.isError} highlight={highlight} highlightActive={highlightActive} />
							</div>
						)}
						{running && !item.toolResult && (
							<span className="text-xs text-muted">{t("conversation.running")}</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

function AssistantActions({ text, visible, timestamp }: { text: string; visible: boolean; timestamp?: number }) {
	const { t } = useTranslation();
	const [copied, copy] = useCopy();
	const [feedback, setFeedback] = useState<null | "up" | "down">(null);
	const time = formatMessageTime(timestamp);
	return (
		<div
			className={cn(
				"mt-2 flex items-center gap-1 transition-opacity",
				visible ? "opacity-100" : "pointer-events-none opacity-0",
			)}
		>
			<button
				type="button"
				onClick={() => copy(text)}
				className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
				title={t("common.copy")}
			>
				{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
			<button
				type="button"
				onClick={() => setFeedback((f) => (f === "up" ? null : "up"))}
				className={cn(
					"flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-2",
					feedback === "up" ? "text-success" : "text-muted hover:text-fg",
				)}
				title={t("conversation.goodResponse")}
			>
				<ThumbsUp className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={() => setFeedback((f) => (f === "down" ? null : "down"))}
				className={cn(
					"flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-2",
					feedback === "down" ? "text-danger" : "text-muted hover:text-fg",
				)}
				title={t("conversation.badResponse")}
			>
				<ThumbsDown className="h-3.5 w-3.5" />
			</button>
			{time && (
				<span className="ml-1 text-[11px] text-muted" title={new Date(timestamp!).toLocaleString()}>
					{time}
				</span>
			)}
		</div>
	);
}

const UserBubble = memo(function UserBubble({ item, highlight, highlightActive }: { item: TimelineItem; highlight?: string; highlightActive?: boolean }) {
	const { t } = useTranslation();
	const [copied, copy] = useCopy();
	const [hover, setHover] = useState(false);
	return (
		<div
			className="my-4 flex flex-col items-end"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<div
				className={cn(
					"max-w-[85%] rounded-2xl bg-surface-2 px-4 py-2.5 text-fg",
					item.queued && "opacity-60",
				)}
			>
				{item.images && item.images.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.images.map((src, i) => (
							<img
								key={i}
								src={src}
								alt={t("conversation.attachment")}
								className="max-h-48 rounded-md border border-current/20 object-contain"
							/>
						))}
					</div>
				)}
				{item.files && item.files.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.files.map((f) => (
							<div
								key={f.absolutePath}
								className="flex h-9 w-48 items-center gap-2 overflow-hidden rounded-lg border border-current/15 bg-current/10 px-2.5 text-xs"
								title={f.absolutePath}
							>
								<FileAttachmentIcon name={f.name} mimeType={f.mimeType} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate">{f.name}</span>
									{f.size > 0 && (
										<span className="truncate text-[10px] opacity-60">{formatFileSize(f.size)}</span>
									)}
								</div>
							</div>
						))}
					</div>
				)}
				{item.text && (
					<div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
						{highlight ? highlightText(item.text, highlight, highlightActive) : item.text}
					</div>
				)}
			</div>
			{item.queued ? (
				<span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted">
					<Loader2 className="h-3 w-3 animate-spin" />
					{t("conversation.queued")}
				</span>
			) : (
				item.text && (
					<div
						className={cn(
							"mt-1 flex items-center gap-1 transition-opacity",
							hover ? "opacity-100" : "pointer-events-none opacity-0",
						)}
					>
						<button
							type="button"
							onClick={() => copy(item.text)}
							className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={t("common.copy")}
						>
							{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
						</button>
						{formatMessageTime(item.timestamp) && (
							<span
								className="ml-1 text-[11px] text-muted"
								title={new Date(item.timestamp!).toLocaleString()}
							>
								{formatMessageTime(item.timestamp)}
							</span>
						)}
					</div>
				)
			)}
		</div>
	);
});

/**
 * Incoming cross-workspace agent message (a gateway `_tell` delivery). Rendered
 * as a distinct left-aligned card — sender workspace header, auto-relay badge,
 * envelope-stripped body, and a trust-trailer footnote — instead of the raw
 * `<message from=...>` markup the agent sees in its context.
 */
const AgentMessageCard = memo(function AgentMessageCard({
	item,
	highlight,
	highlightActive,
}: {
	item: TimelineItem;
	highlight?: string;
	highlightActive?: boolean;
}) {
	const { t } = useTranslation();
	const [copied, copy] = useCopy();
	const [hover, setHover] = useState(false);
	const am = item.agentMessage;
	const time = formatMessageTime(item.timestamp);
	// Defensive: the timeline only routes envelope messages here, but fall back
	// to the plain user bubble rather than crash on malformed items.
	if (!am) return <UserBubble item={item} highlight={highlight} highlightActive={highlightActive} />;
	return (
		<div
			className="my-4 flex flex-col items-start"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<div className="w-full max-w-[85%] overflow-hidden rounded-2xl border border-border bg-surface">
				<div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2">
					<Waypoints className="h-3.5 w-3.5 shrink-0 text-muted" />
					<span className="shrink-0 text-[11px] font-medium text-muted">
						{t("conversation.agentMessage.title")}
					</span>
					<span
						className="truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg"
						title={am.from}
					>
						{highlight ? highlightText(am.fromName, highlight, highlightActive) : am.fromName}
					</span>
					{am.autoRelay && (
						<span
							className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
							title={t("conversation.agentMessage.autoRelayHint")}
						>
							<ArrowUpRight className="h-3 w-3" />
							{t("conversation.agentMessage.autoRelay")}
						</span>
					)}
					{am.id && (
						<span className="ml-auto truncate text-[10px] text-muted/70" title={am.id}>
							{am.id}
						</span>
					)}
				</div>
				<div className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed text-fg">
					{highlight ? highlightText(am.body, highlight, highlightActive) : am.body}
				</div>
				{item.gatewayTrailer && (
					<div
						className="flex items-center gap-1.5 border-t border-border/70 px-4 py-1.5 text-[10px] text-muted/80"
						title={t("conversation.agentMessage.trailerHint")}
					>
						<ShieldAlert className="h-3 w-3 shrink-0" />
						<span className="truncate">{t("conversation.agentMessage.trailer")}</span>
					</div>
				)}
			</div>
			<div
				className={cn(
					"mt-1 flex items-center gap-1 transition-opacity",
					hover ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			>
				<button
					type="button"
					onClick={() => copy(item.text)}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("common.copy")}
				>
					{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
				</button>
				{time && (
					<span className="ml-1 text-[11px] text-muted" title={new Date(item.timestamp!).toLocaleString()}>
						{time}
					</span>
				)}
			</div>
		</div>
	);
});

/** Small inline notice for system-originated events (e.g. scheduled task fired). */
const SystemNotice = memo(function SystemNotice({ item }: { item: TimelineItem }) {
	const ts = item.timestamp ? new Date(item.timestamp).toLocaleString() : "";
	return (
		<div className="my-3 flex items-center justify-center gap-2 text-[11px] text-muted">
			<span className="h-px flex-1 bg-border/60" />
			<span className="rounded-full border border-border bg-surface px-2.5 py-0.5">
				{item.title}
			</span>
			{ts && <span className="text-muted/70">{ts}</span>}
			<span className="h-px flex-1 bg-border/60" />
		</div>
	);
});

const AssistantMessage = memo(function AssistantMessage({ item, highlight, highlightActive }: { item: TimelineItem; highlight?: string; highlightActive?: boolean }) {
	const { t } = useTranslation();
	const [hover, setHover] = useState(false);
	return (
		<div
			className="my-4 flex justify-start"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<div className="w-full max-w-full">
				{item.thinking && <Thinking text={item.thinking} streaming={item.streaming} highlight={highlight} highlightActive={highlightActive} />}
				{item.images && item.images.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.images.map((src, i) => (
							<img
								key={i}
								src={src}
								alt={t("conversation.attachment")}
								className="max-h-48 rounded-md border border-border object-contain"
							/>
						))}
					</div>
				)}
				{item.files && item.files.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.files.map((f) => (
							<div
								key={f.absolutePath}
								className="flex h-9 w-48 items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface-2 px-2.5 text-xs"
								title={f.absolutePath}
							>
								<FileAttachmentIcon name={f.name} mimeType={f.mimeType} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-fg">{f.name}</span>
									{f.size > 0 && (
										<span className="truncate text-[10px] text-muted">{formatFileSize(f.size)}</span>
									)}
								</div>
							</div>
						))}
					</div>
				)}
				{item.text ? (
					<Markdown highlight={highlight} highlightActive={highlightActive}>{item.text}</Markdown>
				) : item.streaming ? (
					<span className="inline-flex items-center gap-2 text-sm text-muted">
						<Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
					</span>
				) : null}
				{item.streaming && item.text && (
					<span className="ml-0.5 animate-pulse text-accent">▋</span>
				)}
				{!item.streaming && item.text && <AssistantActions text={item.text} visible={hover} timestamp={item.timestamp} />}
			</div>
		</div>
	);
});

/**
 * Progressive rendering: when a large history is loaded (e.g. switching to a
 * workspace with 1000+ messages), rendering all items at once blocks the main
 * thread for seconds. Instead, render the last BATCH_SIZE items first (so the
 * user sees the most recent conversation immediately), then progressively add
 * older items one batch per animation frame until everything is visible.
 */
const PROGRESSIVE_BATCH_SIZE = 50;
const PROGRESSIVE_INITIAL = 50;
/** Distance from the bottom (px) within which the view counts as at the
 * bottom and follows newly appended content. Slightly larger than the
 * composer-area padding (pb-32 = 128px) so a resting view stays pinned. */
const FOLLOW_BOTTOM_THRESHOLD_PX = 160;

export function Conversation({
	items,
	onResolveApproval,
	searchQuery,
	activeMatchId,
}: {
	items: TimelineItem[];
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	onResolveApproval?: (intentEventId: string, toolCallId: string, approved: boolean) => void;
	/** Active chat-search query (empty/undefined when search is off). */
	searchQuery?: string;
	/** Item id of the currently-focused search match, for highlight + scroll. */
	activeMatchId?: string | null;
}) {
	// When a search is active we must render every item (otherwise matches in
	// the progressive-render tail wouldn't exist in the DOM to scroll to), so
	// treat the list as fully rendered up-front. Searching a huge conversation
	// is an explicit user action, so the perf trade-off is acceptable.
	const searching = !!searchQuery && searchQuery.length > 0;

	// Number of items to render, counted from the END of the array.
	// Starts small and grows until it covers all items.
	const [renderCount, setRenderCount] = useState(Math.min(PROGRESSIVE_INITIAL, items.length));
	// Track the items array we're currently rendering for. When items change
	// (e.g. new streaming message appended), reset renderCount only if the
	// array identity changed due to a full reload, not a streaming append.
	const prevItemsRef = useRef(items);
	const fullRenderRef = useRef(items.length <= PROGRESSIVE_INITIAL);

	useEffect(() => {
		const prev = prevItemsRef.current;
		// If the new items array is a completely different set (e.g. workspace
		// switch or session reload), reset to progressive rendering.
		// Heuristic: if the first item's id changed, it's a new conversation.
		const isFullReload = prev.length === 0 || items.length === 0 || prev[0]?.id !== items[0]?.id;
		if (isFullReload) {
			fullRenderRef.current = items.length <= PROGRESSIVE_INITIAL;
			setRenderCount(Math.min(PROGRESSIVE_INITIAL, items.length));
		} else if (items.length > prev.length) {
			// Items were appended (streaming). If we've already rendered
			// everything, keep renderCount in sync so the new item shows.
			if (fullRenderRef.current) {
				setRenderCount(items.length);
			}
		}
		prevItemsRef.current = items;
	}, [items]);

	const bottomAnchorRef = useRef<HTMLDivElement>(null);
	const getScrollContainer = (): HTMLElement | null => {
		const anchor = bottomAnchorRef.current;
		if (!anchor) return null;
		// Walk up to find the overflow-y-auto container.
		let el: HTMLElement | null = anchor.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (style.overflowY === "auto" || style.overflowY === "scroll") return el;
			el = el.parentElement;
		}
		return null;
	};

	// Live "is the user at the bottom" tracker, driven by native scroll events
	// (NOT by render cycles — the user can scroll between renders, and a stale
	// render-time snapshot would wrongly pin or release the follow behavior).
	const atBottomRef = useRef(true);
	useEffect(() => {
		const anchor = bottomAnchorRef.current;
		if (!anchor) return;
		let el: HTMLElement | null = anchor.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (style.overflowY === "auto" || style.overflowY === "scroll") break;
			el = el.parentElement;
		}
		if (!el) return;
		// The component owns its scroll behavior (jump-to-bottom on first render,
		// follow on append, compensation across progressive batches). The browser
		// native scroll anchoring fights all three — it yanks the viewport back
		// to its heuristic anchor right after we set scrollTop — so disable it.
		el.style.overflowAnchor = "none";
		const onScroll = () => {
			atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_THRESHOLD_PX;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// Scroll height measured right before a progressive batch is applied.
	// Used to compensate scrollTop after older items are prepended, so the
	// user's viewport shows exactly the same content before and after.
	const preBatchScrollHeightRef = useRef<number | null>(null);

	// Progressive rendering: grow renderCount by one batch per frame until
	// all items are visible. Before each batch, snapshot the current
	// scrollHeight so the layout effect below can keep the viewport steady.
	useEffect(() => {
		if (searching) {
			// Searching forces full render; nothing to grow.
			fullRenderRef.current = true;
			return;
		}
		if (renderCount >= items.length) {
			fullRenderRef.current = true;
			return;
		}
		const raf = requestAnimationFrame(() => {
			const container = getScrollContainer();
			preBatchScrollHeightRef.current = container ? container.scrollHeight : null;
			setRenderCount((prev) => Math.min(prev + PROGRESSIVE_BATCH_SIZE, items.length));
		});
		return () => cancelAnimationFrame(raf);
	}, [renderCount, items.length, searching]);

	// Keep the viewport visually stable across renders.
	//
	// Three distinct cases:
	//  1. First render of a conversation → jump to the bottom so the user
	//     starts at the newest message.
	//  2. Progressive batch prepended older items → scrollHeight grew above
	//     the viewport. Add the growth delta to scrollTop so the content the
	//     user is looking at stays exactly where it was. Without this the
	//     page appears to scroll on its own.
	//  3. New content appended (user submits a message, streaming text grows,
	//     an incoming agent message arrives) -> follow the bottom when the
	//     user was already there. Without this the viewport stays at its old
	//     scrollTop while content grows below it, so after submitting a
	//     message the list appeared to stick in the middle instead of
	//     showing the newest bubble.
	const isFirstRenderRef = useRef(true);
	const prevLenRef = useRef(items.length);
	const prevLastIdRef = useRef("");
	useLayoutEffect(() => {
		const container = getScrollContainer();
		if (!container) return;

		if (isFirstRenderRef.current) {
			isFirstRenderRef.current = false;
			preBatchScrollHeightRef.current = null;
			container.scrollTop = container.scrollHeight;
			prevLenRef.current = items.length;
			prevLastIdRef.current = items[items.length - 1]?.id ?? "";
			return;
		}

		const before = preBatchScrollHeightRef.current;
		preBatchScrollHeightRef.current = null;
		if (before !== null) {
			const delta = container.scrollHeight - before;
			if (delta > 0) {
				container.scrollTop += delta;
			}
		}

		// Follow appended content. The user submitting a message always brings
		// the newest bubble into view; anything else (streaming, incoming agent
		// messages) only follows when the user was already near the bottom, so
		// scrolling up to read history is never interrupted.
		const lastItem = items[items.length - 1];
		const appended = items.length !== prevLenRef.current || (lastItem?.id ?? "") !== prevLastIdRef.current;
		if (appended && (atBottomRef.current || (lastItem?.role === "user" && !lastItem.agentMessage))) {
			container.scrollTop = container.scrollHeight;
		}
	}, [items, renderCount]);

	// Reset first-render flag when a full reload happens (workspace/session
	// switch) so the new conversation gets an initial scroll-to-bottom.
	const firstItemId = items.length > 0 ? items[0].id : "";
	useEffect(() => {
		isFirstRenderRef.current = true;
	}, [firstItemId]);

	// Refs to each rendered item wrapper, keyed by item id. Used to scroll the
	// active search match into view.
	const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

	// Scroll the active match into view (centered) whenever it changes. The
	// element is guaranteed to exist because searching forces a full render.
	useEffect(() => {
		if (!activeMatchId) return;
		const el = itemRefs.current.get(activeMatchId);
		if (el) {
			el.scrollIntoView({ block: "center" });
		}
	}, [activeMatchId]);

	if (items.length === 0) {
		return <div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center gap-4 text-center text-muted" />;
	}

	// Render only the last `renderCount` items. Older items are progressively
	// added as renderCount grows, so the user sees recent messages instantly.
	// While searching, render everything so all matches are present in the DOM.
	const visibleItems = searching || renderCount >= items.length ? items : items.slice(items.length - renderCount);

	return (
		<div className="mx-auto max-w-3xl px-6 pb-32 pt-4">
			{visibleItems.map((item) => {
				const isActive = item.id === activeMatchId;
				let content: React.ReactNode;
				if (item.role === "user") {
					content = item.agentMessage ? (
						<AgentMessageCard item={item} highlight={searchQuery} highlightActive={isActive} />
					) : (
						<UserBubble item={item} highlight={searchQuery} highlightActive={isActive} />
					);
				} else if (item.role === "system") {
					content = <SystemNotice item={item} />;
				} else if (item.role === "tool") {
					content = <ToolCard item={item} onResolveApproval={onResolveApproval} highlight={searchQuery} highlightActive={isActive} />;
				} else if (!item.streaming && !item.text && !item.thinking && !(item.images && item.images.length > 0)) {
					// Skip empty assistant bubbles (turns that produced only tool calls).
					return null;
				} else {
					content = <AssistantMessage item={item} highlight={searchQuery} highlightActive={isActive} />;
				}
				return (
					<div
						key={item.id}
						ref={(el) => {
							if (el) itemRefs.current.set(item.id, el);
							else itemRefs.current.delete(item.id);
						}}
					>
						{content}
					</div>
				);
			})}
			<div ref={bottomAnchorRef} />
		</div>
	);
}
