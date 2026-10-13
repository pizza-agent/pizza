import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, Square, Mic, Plus, ChevronDown, Check, X, Loader2, Shield, ShieldCheck, Paperclip, Sparkles, MessageSquarePlus, FolderOpen, Clock, Terminal, ChevronRight, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn, isTauri, samePath, pathBasename } from "@/lib/utils";
import {
	loadFileAttachment,
	loadPathAttachments,
	type LoadedFileAttachment,
	type RejectedAttachment,
} from "@/lib/file-attachment";
import { FileAttachmentIcon } from "@/components/FileAttachmentIcon";
import { ScheduleMenu } from "@/components/ScheduleMenu";
import { MentionMenu, type MentionCategory, type MentionItem } from "@/components/MentionMenu";
import { SlashMenu } from "@/components/SlashMenu";
import { Modal } from "@/components/ui";
import { alertDialog } from "@/lib/confirm";
import {
	DESKTOP_BUILTIN_COMMANDS,
	filterSlashItems,
	parseSlashInput,
	slashQueryAt,
	type BuiltinCommandName,
	type SlashItem,
} from "@/lib/slash-commands";
import { formatFileSize } from "@/lib/file-format";

export type { LoadedFileAttachment } from "@/lib/file-attachment";
import { sendCommandAwait, setApprovalPolicy, newSession, getSkills, getCommands, runBash, invoke, searchFiles, gitBranches, listScheduledTasks, type SkillInfo, type SlashCommandInfo, type GitBranchEntry } from "@/lib/transport";
import type { RpcSessionState, RpcContextUsage, RpcTokenUsage, ModelInfo } from "@/lib/types";
import type { WorkspaceMeta, ScheduledTaskSummary } from "@/lib/types";
import { resolveScheduleScope } from "@/lib/schedule-scope";
import { COMPOSER_PREFILL_EVENT, type ComposerPrefillDetail } from "@/lib/composer-prefill";
import { Z } from "@/lib/z-index";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Display order of mention categories in the @ popup (files first, like IDE
 *  quick-open). Used as the primary sort key when filtering so category
 *  blocks stay contiguous and the menu section headers stay unique. */
const MENTION_CATEGORY_RANK: Record<MentionCategory, number> = {
	file: 0,
	branch: 1,
	workspace: 2,
	skill: 3,
	schedule: 4,
};

/** Longest `@…` query we still treat as a mention. Beyond this the `@` was
 *  almost certainly ordinary prose (an e-mail, a handle, a sentence), so the
 *  menu closes instead of lingering with no results. */
const MENTION_MAX_QUERY = 64;

/** Format a token count compactly (e.g. 12.3k, 1.2M). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/** Small circular progress ring showing context window usage. */
function ContextRing({
	contextUsage,
	tokenUsage,
}: {
	contextUsage?: RpcContextUsage;
	tokenUsage?: RpcTokenUsage;
}) {
	const { t } = useTranslation();
	const [hover, setHover] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	const percent = contextUsage?.percent ?? null;
	const tokens = contextUsage?.tokens ?? null;
	const contextWindow = contextUsage?.contextWindow ?? 0;

	// Clamp for the arc; null → show as 0 (unknown).
	const pct = percent !== null ? Math.min(100, Math.max(0, percent)) : 0;
	const known = percent !== null && tokens !== null;

	// Color based on usage level.
	const color = !known
		? "var(--color-muted, #888)"
		: pct > 90
			? "var(--color-danger, #ef4444)"
			: pct > 70
				? "var(--color-warning, #f59e0b)"
				: "var(--color-success, #22c55e)";

	// SVG arc geometry.
	const size = 16;
	const stroke = 2.5;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	const dashOffset = circumference * (1 - pct / 100);

	const inputTokens = tokenUsage?.totalInput ?? 0;
	const outputTokens = tokenUsage?.totalOutput ?? 0;
	const cacheRead = tokenUsage?.totalCacheRead ?? 0;
	const cacheWrite = tokenUsage?.totalCacheWrite ?? 0;
	const cost = tokenUsage?.totalCost ?? 0;

	const tooltipLines = known
		? [
				`${t("composer.contextUsed")}: ${formatTokens(tokens!)} / ${formatTokens(contextWindow)} (${percent!.toFixed(1)}%)`,
				`${t("composer.inputTokens")}: ${formatTokens(inputTokens)}`,
				`${t("composer.outputTokens")}: ${formatTokens(outputTokens)}`,
			]
		: [
				`${t("composer.contextUsed")}: ? / ${formatTokens(contextWindow)}`,
				`${t("composer.inputTokens")}: ${formatTokens(inputTokens)}`,
				`${t("composer.outputTokens")}: ${formatTokens(outputTokens)}`,
			];
	if (cacheRead > 0) tooltipLines.push(`${t("composer.cacheRead")}: ${formatTokens(cacheRead)}`);
	if (cacheWrite > 0) tooltipLines.push(`${t("composer.cacheWrite")}: ${formatTokens(cacheWrite)}`);
	if (cost > 0) tooltipLines.push(`${t("composer.cost")}: $${cost.toFixed(3)}`);

	return (
		<div
			ref={wrapRef}
			className="relative flex items-center"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="var(--color-border, #333)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
				/>
			</svg>
			{hover && (
				<div className={cn("absolute bottom-full right-0 mb-2 w-max max-w-[16rem] rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-fg shadow-lg", Z.menu)}>
					{tooltipLines.map((line, i) => (
						<div key={i} className={i === 0 ? "font-medium" : "text-muted"}>
							{line}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export interface ComposerImage {
	/** base64-encoded payload (no data URL prefix) */
	data: string;
	mimeType: string;
	/** original file name, for display */
	name: string;
	/** data URL for preview thumbnail */
	preview: string;
}

interface SpeechRecognitionAlternative {
	transcript: string;
	confidence?: number;
	readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResult {
	readonly length: number;
	readonly isFinal: boolean;
	readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
	readonly length: number;
	readonly [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}


import { saveDraft, loadDraft } from "@/lib/composer-drafts";

export function Composer({
	sidecarReady,
	isRunning,
	state,
	workspace,
	workspaces,
	onSend,
	onAbort,
	onRefreshState,
}: {
	sidecarReady: boolean;
	isRunning: boolean;
	state: RpcSessionState | null;
	workspace?: string | null;
	/** All known workspaces — used for @workspace mentions. */
	workspaces?: WorkspaceMeta[];
	/**
	 * Send the composed message. `images` become base64 image attachments;
	 * `files` become path references the agent can read with its own file tools.
	 * Either may be omitted.
	 */
	onSend: (message: string, images?: ComposerImage[], files?: LoadedFileAttachment[]) => void;
	onAbort: () => void;
	onRefreshState?: () => void;
}) {
	const [input, setInput] = useState("");
	const [images, setImages] = useState<ComposerImage[]>([]);
	const [files, setFiles] = useState<LoadedFileAttachment[]>([]);
	const [rejected, setRejected] = useState<RejectedAttachment[]>([]);
	const [isDragOver, setIsDragOver] = useState(false);
	const dragDepthRef = useRef(0);
	// Per-workspace draft isolation. Drafts live in a MODULE-LEVEL store, not
	// refs: switching workspaces briefly unmounts the whole AgentView (the
	// `waitingForWorkspace` full-screen loader in App.tsx), which would discard
	// any draft kept in component state/refs. The module store survives
	// unmounts, so an unsent draft is still there when the user switches back.
	const prevWsRef = useRef<string | null>(null);
	// Latest draft state for the unmount handler (avoids stale closures).
	const draftStateRef = useRef({ input, images, files });
	// Keep the ref in sync on every render — the unmount handler and the
	// switch handler read it to persist the LATEST draft, not the mount-time one.
	draftStateRef.current = { input, images, files };
	useEffect(() => {
		const prevWs = prevWsRef.current;
		const newWs = workspace ?? "";
		if (prevWs === newWs) return;
		// Save the current draft under the workspace we're leaving.
		if (prevWs) {
			saveDraft(prevWs, draftStateRef.current);
		}
		// Restore (or clear) the draft for the workspace we're entering.
		const restored = loadDraft(newWs);
		setInput(restored.input);
		setImages(restored.images);
		setFiles(restored.files);
		prevWsRef.current = newWs;
	}, [workspace]);
	// Save the draft when the Composer unmounts (e.g. the workspace-switch
	// loading screen) so nothing typed is lost.
	useEffect(() => {
		return () => {
			const ws = prevWsRef.current;
			if (ws) saveDraft(ws, draftStateRef.current);
		};
	}, []);
	const [models, setModels] = useState<ModelInfo[]>([]);
	// Registry size, including unconfigured models (not sent with authOnly).
	const [modelTotal, setModelTotal] = useState(0);
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	// Voice-input UX state: elapsed timer + input level + interim speech text
	// (browser path) + dismissable error strip.
	const [recordSecs, setRecordSecs] = useState(0);
	const [recordLevel, setRecordLevel] = useState(0);
	const [interimText, setInterimText] = useState("");
	const [voiceError, setVoiceError] = useState<string | null>(null);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
	const { t } = useTranslation();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const recognitionRef = useRef<SpeechRecognition | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioChunksRef = useRef<Blob[]>([]);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const recordCancelledRef = useRef(false);
	const recordStartRef = useRef(0);
	const recordMimeRef = useRef("audio/webm");
	const audioCtxRef = useRef<AudioContext | null>(null);
	const levelRafRef = useRef(0);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const approvalMenuRef = useRef<HTMLDivElement>(null);
	const plusMenuRef = useRef<HTMLDivElement>(null);
	const [plusMenuOpen, setPlusMenuOpen] = useState(false);
	// Scheduled-task popover. Owned here so the + menu entry and the clock
	// button open the exact same surface instead of diverging.
	const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const navigate = useNavigate();

	// --- / slash command state --------------------------------------------
	// Typing `/` as the first character opens a command popup (mirrors the
	// TUI's autocomplete): builtin desktop actions plus the agent-side
	// commands reported by `get_commands` (skills, prompt templates,
	// extension commands). `slashQuery` is the text between `/` and the
	// cursor — the menu only stays open while the cursor is inside the
	// command token (typing a space ends it and frees @ mentions in args).
	const [agentCommands, setAgentCommands] = useState<SlashCommandInfo[]>([]);
	const [slashActive, setSlashActive] = useState(false);
	const [slashQuery, setSlashQuery] = useState("");
	const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
	const slashActiveRef = useRef(false);
	const slashSelectedIndexRef = useRef(0);
	const slashQueryRef = useRef<string | null>(null);

	// --- ! bash state -------------------------------------------------------
	// `!cmd` runs a shell command via the `bash` RPC and shows the result in
	// a card above the input instead of sending a message (TUI parity).
	const [bashRunning, setBashRunning] = useState(false);
	const [bashResult, setBashResult] = useState<{
		command: string;
		output: string;
		exitCode?: number;
		cancelled: boolean;
		truncated: boolean;
	} | null>(null);

	// /export result dialog — shows the written HTML path + reveal button.
	const [exportResult, setExportResult] = useState<{ path: string } | null>(null);
	const [compacting, setCompacting] = useState(false);

	// --- @ mention state --------------------------------------------------
	// When the user types `@` in the textarea we show a popup listing files,
	// branches, workspaces, skills and scheduled tasks. The popup is driven by
	// `mentionActive`; `mentionQuery` is the text after `@` (up to the cursor);
	// `mentionStart` is the character index of `@` so we can replace it on
	// selection. `mentionSelectedIndex` tracks keyboard navigation.
	const [mentionActive, setMentionActive] = useState(false);
	const [mentionQuery, setMentionQuery] = useState("");
	const [mentionStart, setMentionStart] = useState(-1);
	const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
	// Cached data for the mention popup — fetched lazily the first time the
	// menu opens, then refreshed on workspace change.
	const [mentionFiles, setMentionFiles] = useState<{ name: string; path: string; is_dir: boolean }[]>([]);
	const [mentionBranches, setMentionBranches] = useState<GitBranchEntry[]>([]);
	const [mentionSchedules, setMentionSchedules] = useState<ScheduledTaskSummary[]>([]);
	const mentionDataLoadedRef = useRef(false);
	// Track the last mention query so we only reset the selected index when
	// the query actually changes — not on every cursor re-evaluation.
	// Initialized to null (not "") so the first `@` (empty query) still
	// triggers a reset.
	const mentionQueryRef = useRef<string | null>(null);
	// Refs mirroring mention state for use inside the textarea onKeyDown
	// handler — this avoids stale closures when the handler captures values
	// from a render where data hadn't loaded yet.
	const mentionActiveRef = useRef(false);
	const mentionSelectedIndexRef = useRef(0);

	// Only show models whose provider has valid auth. Models without auth
	// (hasAuth === false) are hidden from the selector entirely — they can't
	// be used until the user configures an API key in Settings.
	const visibleModels = models.filter((m) => m.hasAuth !== false);

	// Model-selector search — the popup filters by name / provider:id as you
	// type; `/model <query>` prefills this when no exact match exists.
	const [modelQuery, setModelQuery] = useState("");
	const [modelMenuIndex, setModelMenuIndex] = useState(0);
	const modelSearchRef = useRef<HTMLInputElement>(null);
	const modelItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

	const filteredModels = useMemo(() => {
		const q = modelQuery.trim().toLowerCase();
		if (!q) return visibleModels;
		return visibleModels.filter(
			(m) =>
				m.name.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q) ||
				`${m.provider}/${m.id}`.toLowerCase().includes(q),
		);
	}, [visibleModels, modelQuery]);

	// Focus the search box when the model menu opens; reset state on close.
	useEffect(() => {
		if (modelMenuOpen) {
			setModelMenuIndex(0);
			requestAnimationFrame(() => modelSearchRef.current?.focus());
		} else {
			setModelQuery("");
		}
	}, [modelMenuOpen]);

	// Keep the keyboard-highlighted model in view while navigating.
	useEffect(() => {
		modelItemRefs.current.get(modelMenuIndex)?.scrollIntoView({ block: "nearest" });
	}, [modelMenuIndex]);

	const hasSpeechSupport =
		typeof window !== "undefined" &&
		(isTauri() ||
			"SpeechRecognition" in window ||
			"webkitSpeechRecognition" in window);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait<{ models: ModelInfo[]; total?: number }>(
					{ type: "get_available_models", authOnly: true },
					30000,
				);
				if (cancelled) return;
				const list = r.data?.models ?? [];
				setModels(list);
				// Older agents ignore authOnly and omit total — they send everything.
				setModelTotal(r.data?.total ?? list.length);
			} catch {
				// Silently ignore — models list will be empty until sidecar recovers.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sidecarReady, state?.sessionId]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
	}, [input]);

	useEffect(() => {
		return () => {
			recognitionRef.current?.stop();
			mediaRecorderRef.current?.stop();
			mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
		};
	}, []);

	// Close model menu on outside click.
	useEffect(() => {
		if (!modelMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
				setModelMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [modelMenuOpen]);

	// Close approval policy menu on outside click.
	useEffect(() => {
		if (!approvalMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (approvalMenuRef.current && !approvalMenuRef.current.contains(e.target as Node)) {
				setApprovalMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [approvalMenuOpen]);

	// Load available skills (invocable as slash commands) for the + menu, and
	// the agent-side slash commands (skills / prompt templates / extension
	// commands) for the `/` popup.
	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		(async () => {
			const list = await getSkills();
			// get_skills also reports disabled skills (for the plugins UI); only
			// enabled ones are actually invocable.
			if (!cancelled) setSkills(list.filter((skill) => skill.enabled));
			const commands = await getCommands();
			if (!cancelled) setAgentCommands(commands);
		})();
		return () => {
			cancelled = true;
		};
	}, [sidecarReady, state?.sessionId]);

	// --- @ mention data fetching ------------------------------------------
	// Lazily load files, branches and schedules the first time the mention
	// menu opens. Skills come from the effect above; workspaces come from the
	// prop. We reset the cache on workspace switch so stale data from another
	// workspace never leaks into the popup.
	useEffect(() => {
		mentionDataLoadedRef.current = false;
		setMentionFiles([]);
		setMentionBranches([]);
		setMentionSchedules([]);
	}, [workspace]);

	const ensureMentionData = useCallback(async () => {
		if (mentionDataLoadedRef.current) return;
		mentionDataLoadedRef.current = true;
		const cwd = workspace ?? "";
		// Fetch files, branches and schedules in parallel. Files are searched
		// recursively (all depths, shallowest first) so the @ menu can reference
		// files in nested directories — not just the workspace root.
		const [fileEntries, branches, schedules] = await Promise.all([
			searchFiles(cwd, null, 1000).catch(() => []),
			gitBranches(cwd).catch(() => []),
			(async () => {
				const { scope, workspaceId } = resolveScheduleScope(cwd);
				return listScheduledTasks(scope, workspaceId).catch(() => []);
			})(),
		]);
		setMentionFiles(fileEntries.map((e) => ({ name: e.name, path: e.path, is_dir: e.is_dir })));
		setMentionBranches(branches);
		setMentionSchedules(schedules as ScheduledTaskSummary[]);
	}, [workspace]);

	// Build the full mention items list from all data sources.
	const mentionItems = useMemo<MentionItem[]>(() => {
		const items: MentionItem[] = [];
		const cwd = (workspace ?? "").replace(/\/+$/, "");

		// Files (recursive, all depths — shallowest first). The label is the
		// basename; the description is the workspace-relative path so nested
		// files are distinguishable. The inserted text uses the relative path
		// so `@src/components/Terminal.tsx` is unambiguous for nested files
		// (root files keep `@Terminal.tsx` since path === name there).
		for (const f of mentionFiles) {
			const abs = cwd ? `${cwd}/${f.path}` : f.path;
			items.push({
				category: "file",
				label: f.name,
				description: f.path,
				insertText: `@${f.path}`,
				absolutePath: abs,
			});
		}

		// Branches.
		for (const b of mentionBranches) {
			items.push({
				category: "branch",
				label: b.name,
				description: b.is_current ? t("mention.currentBranch") : b.is_remote ? t("mention.remoteBranch") : undefined,
				insertText: `@branch:${b.name}`,
			});
		}

		// Workspaces.
		for (const ws of workspaces ?? []) {
			const name = pathBasename(ws.cwd);
			items.push({
				category: "workspace",
				label: name,
				description: ws.cwd,
				insertText: `@workspace:${name}`,
			});
		}

		// Skills.
		for (const s of skills) {
			items.push({
				category: "skill",
				label: s.name,
				description: s.description,
				insertText: `@skill:${s.name}`,
			});
		}

		// Scheduled tasks.
		for (const task of mentionSchedules) {
			items.push({
				category: "schedule",
				label: task.name,
				description: task.enabled ? t("mention.scheduleEnabled") : t("mention.scheduleDisabled"),
				insertText: `@schedule:${task.name}`,
			});
		}

		return items;
	}, [mentionFiles, mentionBranches, workspaces, skills, mentionSchedules, workspace, t]);

	// Keep refs in sync with state so the onKeyDown handler always sees the
	// latest values, even if its closure was created during a render where
	// the data hadn't arrived yet.
	mentionActiveRef.current = mentionActive;
	mentionSelectedIndexRef.current = mentionSelectedIndex;

	// Compute the filtered list once and share it between the onKeyDown
	// handler and the MentionMenu via a ref — this guarantees both use the
	// same list, even across rapid re-renders.
	const filteredMentionItems = useMemo(() => {
		const q = mentionQuery.toLowerCase().trim();
		if (!q) return mentionItems;
		// Score each item by where the query matches:
		//   3 — label starts with the query (e.g. `@index` → index.ts)
		//   2 — label contains the query
		//   1 — insertText (`@skill:lark`, `@branch:main`, …) or description
		//       (file path, workspace cwd, …) contains the query
		// Category blocks keep their original order so the menu headers stay
		// unique; within a block higher scores rank first, and the stable sort
		// preserves the shallowest-first ordering of equally-scored files.
		const scored: { item: MentionItem; score: number }[] = [];
		for (const item of mentionItems) {
			const label = item.label.toLowerCase();
			let score = 0;
			if (label.startsWith(q)) score = 3;
			else if (label.includes(q)) score = 2;
			else if (
				item.insertText.toLowerCase().includes(q) ||
				(item.description?.toLowerCase().includes(q) ?? false)
			) {
				score = 1;
			}
			if (score > 0) scored.push({ item, score });
		}
		scored.sort(
			(a, b) =>
				MENTION_CATEGORY_RANK[a.item.category] - MENTION_CATEGORY_RANK[b.item.category] ||
				b.score - a.score,
		);
		return scored.map((s) => s.item);
	}, [mentionItems, mentionQuery]);
	const filteredMentionItemsRef = useRef(filteredMentionItems);
	filteredMentionItemsRef.current = filteredMentionItems;

	// Close the mention menu and reset the query ref so the next `@` always
	// starts with a fresh selected index.
	const closeMention = useCallback(() => {
		setMentionActive(false);
		mentionQueryRef.current = null;
	}, []);

	// Detect the `@` that starts a mention and track the query text between it
	// and the cursor. Only resets the selected index when the query actually
	// changes — so arrow-key navigation (which may re-trigger detectMention via
	// onKeyUp/onClick) doesn't jump the selection back to 0 mid-navigation.
	const detectMention = useCallback((value: string, cursorPos: number) => {
		// Search backwards from the cursor for the nearest `@`.
		const before = value.slice(0, cursorPos);
		const atIdx = before.lastIndexOf("@");
		if (atIdx < 0) {
			closeMention();
			return;
		}
		// The `@` must not be glued to a preceding word character, otherwise
		// e-mails (`a@b.com`) and scoped paths would pop the menu open. We check
		// for ASCII word/path characters rather than requiring whitespace: CJK
		// text has no spaces, so `帮我看看@Composer` ("take a look @Composer"
		// with no spaces) must still trigger the menu.
		if (atIdx > 0 && /[A-Za-z0-9._~-]/.test(before[atIdx - 1])) {
			closeMention();
			return;
		}
		// The query is the text between `@` and the cursor. Whitespace closes the
		// mention; so does an over-long query, which means the `@` was ordinary
		// prose rather than a mention trigger (and would otherwise keep the menu
		// open, swallowing Enter).
		const query = value.slice(atIdx + 1, cursorPos);
		if (/\s/.test(query) || query.length > MENTION_MAX_QUERY) {
			closeMention();
			return;
		}
		setMentionActive(true);
		setMentionStart(atIdx);
		// Only reset the selected index when the query text actually changes.
		// Uses a ref to avoid nesting setState calls (an anti-pattern that can
		// cause unexpected re-renders and selection jumps during keyboard nav).
		if (mentionQueryRef.current !== query) {
			mentionQueryRef.current = query;
			setMentionQuery(query);
			setMentionSelectedIndex(0);
		}
		// When the menu closes, reset the ref so the next open always resets.
	}, [closeMention]);

	// When the mention menu opens, lazily fetch the data it needs.
	useEffect(() => {
		if (mentionActive) {
			void ensureMentionData();
		}
	}, [mentionActive, ensureMentionData]);

	// Close + menu on outside click.
	useEffect(() => {
		if (!plusMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
				setPlusMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [plusMenuOpen]);

	// Optimistic local override — set immediately on user selection so the
	// trigger label updates without waiting for the MODEL_CHANGED round-trip.
	// Cleared whenever state.model catches up to it.
	const [optimisticModel, setOptimisticModel] = useState<ModelInfo | null>(null);
	useEffect(() => {
		if (!optimisticModel || !state?.model) return;
		if (state.model.provider === optimisticModel.provider && state.model.id === optimisticModel.id) {
			setOptimisticModel(null);
		}
	}, [state?.model, optimisticModel]);

	const displayedModel = optimisticModel ?? state?.model ?? null;
	const currentModelLabel = displayedModel?.name ?? displayedModel?.id ?? t("composer.model");

	const handleModelSelect = useCallback(async (m: ModelInfo) => {
		setModelMenuOpen(false);
		setOptimisticModel(m);
		try {
			await sendCommandAwait({ type: "set_model", provider: m.provider, modelId: m.id });
		} catch (e) {
			console.error("[composer] set_model failed:", e);
			// Revert on failure.
			setOptimisticModel(null);
		}
	}, []);

	const currentThinking = state?.thinkingLevel ?? "off";
	const handleThinkingChange = useCallback(async (level: string) => {
		try {
			await sendCommandAwait({ type: "set_thinking_level", level: level as RpcSessionState["thinkingLevel"] });
			onRefreshState?.();
		} catch (e) {
			console.error("[composer] set_thinking_level failed:", e);
		}
	}, [onRefreshState]);

	// Approval policy for the current session (two states). Selected inline in
	// the composer so the user can choose per-session without visiting Settings.
	// "off" (自动 "automatic") auto-runs everything; "auto" (审批 "approval",
	// default) gates only unknown tools and dangerous commands. Legacy "on"
	// (strict) settings map to 审批 ("approval") in the UI.
	const approvalPolicy = state?.approvalPolicy ?? (state?.safeMode ? "on" : "auto");
	const gated = approvalPolicy !== "off";
	const handleApprovalPolicyChange = useCallback(async (policy: "auto" | "off") => {
		setApprovalMenuOpen(false);
		try {
			await setApprovalPolicy(policy);
			onRefreshState?.();
		} catch (e) {
			console.error("[composer] set_approval_policy failed:", e);
		}
	}, [onRefreshState]);

	// Start a fresh conversation session (new context scope).
	const handleNewSession = useCallback(async () => {
		setPlusMenuOpen(false);
		const sessionId = await newSession();
		if (sessionId) {
			onRefreshState?.();
		}
	}, [onRefreshState]);

	// Insert a skill invocation (slash command) into the input and focus it.
	const handleInsertSkill = useCallback((command: string) => {
		setPlusMenuOpen(false);
		setInput((prev) => {
			const insert = `/${command} `;
			// Put the slash command on its own line so it parses correctly,
			// then the user can type arguments / context below it.
			if (!prev.trim()) return insert;
			return `${prev.trimEnd()}
${insert}`;
		});
		// Refocus the textarea so the user can continue typing arguments.
		requestAnimationFrame(() => textareaRef.current?.focus());
	}, []);

	// --- / slash command menu ----------------------------------------------

	const closeSlash = useCallback(() => {
		setSlashActive(false);
		slashQueryRef.current = null;
	}, []);

	// Track the `/`-command token while the cursor stays inside it.
	const detectSlash = useCallback(
		(value: string, cursorPos: number) => {
			const query = slashQueryAt(value, cursorPos);
			if (query === null) {
				closeSlash();
				return;
			}
			setSlashActive(true);
			if (slashQueryRef.current !== query) {
				slashQueryRef.current = query;
				setSlashQuery(query);
				setSlashSelectedIndex(0);
			}
		},
		[closeSlash],
	);

	// Full item pool: desktop builtins first (i18n descriptions), then the
	// agent-side commands. Builtin names win collisions with extension
	// commands — same precedence as the TUI's builtin intercept.
	const slashItems = useMemo<SlashItem[]>(() => {
		const items: SlashItem[] = DESKTOP_BUILTIN_COMMANDS.map((def) => ({
			category: "builtin",
			name: def.name,
			description: t(`slash.builtin.${def.name}`),
		}));
		const builtinNames = new Set<string>(DESKTOP_BUILTIN_COMMANDS.map((d) => d.name));
		for (const command of agentCommands) {
			if (builtinNames.has(command.name)) continue;
			items.push({
				category: command.source,
				name: command.name,
				description: command.description,
				hint: command.argumentHint,
			});
		}
		return items;
	}, [agentCommands, t]);

	const filteredSlashItems = useMemo(
		() => filterSlashItems(slashItems, slashQuery),
		[slashItems, slashQuery],
	);
	const filteredSlashItemsRef = useRef(filteredSlashItems);
	filteredSlashItemsRef.current = filteredSlashItems;
	slashActiveRef.current = slashActive;
	slashSelectedIndexRef.current = slashSelectedIndex;

	// Execute a desktop builtin. Arg-taking commands arrive here on submit;
	// no-arg commands can also arrive directly from menu selection.
	const dispatchBuiltin = useCallback(
		async (name: BuiltinCommandName, args: string) => {
			switch (name) {
				case "settings":
					navigate("/settings");
					return;
				case "new":
					await handleNewSession();
					return;
				case "model": {
					if (!args) {
						setModelMenuOpen(true);
						return;
					}
					// `/model <query>` — pick the best fuzzy match like the TUI.
					const q = args.toLowerCase();
					const match =
						visibleModels.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q) ??
						visibleModels.find((m) => m.id.toLowerCase() === q) ??
						visibleModels.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(q)) ??
						visibleModels.find((m) => m.id.toLowerCase().includes(q));
					if (match) {
						await handleModelSelect(match);
					} else {
						// No match — open the selector pre-filtered with the query.
						setModelQuery(args);
						setModelMenuOpen(true);
					}
					return;
				}
				case "compact": {
					// The agent waits for COMPACTION_END internally (120s cap) —
					// summarizing a large context is a full LLM call and routinely
					// runs past 30s. Show a working hint while it does.
					setCompacting(true);
					try {
						await sendCommandAwait({ type: "compact" }, 125000);
					} catch (e) {
						void alertDialog({
							title: t("slash.compactFailed"),
							message: e instanceof Error ? e.message : String(e),
						});
					} finally {
						setCompacting(false);
					}
					return;
				}
				case "export": {
					try {
						const r = await sendCommandAwait<{ path: string }>(
							{ type: "export_html", ...(args && { outputPath: args }) },
							60000,
						);
						if (r.data?.path) setExportResult({ path: r.data.path });
					} catch (e) {
						void alertDialog({
							title: t("slash.exportFailed"),
							message: e instanceof Error ? e.message : String(e),
						});
					}
					return;
				}
			}
		},
		[navigate, handleNewSession, visibleModels, handleModelSelect, t],
	);

	const handleSlashSelect = useCallback(
		(item: SlashItem) => {
			closeSlash();
			if (item.category === "builtin") {
				const def = DESKTOP_BUILTIN_COMMANDS.find((d) => d.name === item.name);
				if (def && !def.takesArgs) {
					setInput("");
					void dispatchBuiltin(def.name, "");
					return;
				}
			}
			// Arg-taking builtins and agent commands: complete the command name
			// and let the user type arguments before sending.
			setInput(`/${item.name} `);
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (el) {
					el.focus();
					const pos = el.value.length;
					el.setSelectionRange(pos, pos);
				}
			});
		},
		[closeSlash, dispatchBuiltin],
	);

	// --- ! bash execution ---------------------------------------------------

	const runBashCommand = useCallback(async (command: string) => {
		setBashRunning(true);
		setBashResult({ command, output: "", cancelled: false, truncated: false });
		try {
			const r = await runBash(command);
			setBashResult({ command, ...r });
		} catch (e) {
			setBashResult({
				command,
				output: e instanceof Error ? e.message : String(e),
				exitCode: 1,
				cancelled: false,
				truncated: false,
			});
		} finally {
			setBashRunning(false);
		}
	}, []);

	/** Tear down the mic stream + level meter (shared by stop/cancel). */
	const teardownAudio = useCallback(() => {
		mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
		mediaStreamRef.current = null;
		if (levelRafRef.current) {
			cancelAnimationFrame(levelRafRef.current);
			levelRafRef.current = 0;
		}
		void audioCtxRef.current?.close().catch(() => {});
		audioCtxRef.current = null;
		setRecordLevel(0);
	}, []);

	/** Live input level via WebAudio — cosmetic meter, safe to skip on error. */
	const attachLevelMeter = useCallback((stream: MediaStream) => {
		try {
			const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!Ctx) return;
			const ctx = new Ctx();
			audioCtxRef.current = ctx;
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.6;
			ctx.createMediaStreamSource(stream).connect(analyser);
			const buf = new Uint8Array(analyser.frequencyBinCount);
			const tick = () => {
				if (!audioCtxRef.current) return;
				analyser.getByteFrequencyData(buf);
				let sum = 0;
				for (const v of buf) sum += v;
				setRecordLevel(Math.min(1, sum / buf.length / 140));
				levelRafRef.current = requestAnimationFrame(tick);
			};
			tick();
		} catch { /* meter is best-effort */ }
	}, []);

	const startRecording = useCallback(() => {
		if (isTauri()) {
			// Desktop (Tauri): MediaRecorder capture → sidecar transcribe_audio
			// (voice.pipeline settings) with a Rust/whisper fallback.
			void (async () => {
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					mediaStreamRef.current = stream;
					attachLevelMeter(stream);
					// audio/mp4 (AAC) plays nicest with WKWebKit + whisper.
					const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
						? "audio/mp4"
						: MediaRecorder.isTypeSupported("audio/webm")
							? "audio/webm"
							: "";
					const recorder = mimeType
						? new MediaRecorder(stream, { mimeType })
						: new MediaRecorder(stream);
					recordMimeRef.current = recorder.mimeType || mimeType || "audio/webm";
					audioChunksRef.current = [];
					recorder.ondataavailable = (e) => {
						if (e.data.size > 0) audioChunksRef.current.push(e.data);
					};
					recorder.onstop = () => {
						teardownAudio();
						const cancelled = recordCancelledRef.current;
						recordCancelledRef.current = false;
						const blob = new Blob(audioChunksRef.current, { type: recordMimeRef.current });
						audioChunksRef.current = [];
						if (cancelled || blob.size === 0) {
							setTranscribing(false);
							return;
						}
						const durationMs = Date.now() - recordStartRef.current;
						const reader = new FileReader();
						reader.onload = async () => {
							const result = reader.result;
							if (typeof result !== "string") {
								setTranscribing(false);
								return;
							}
							const comma = result.indexOf(",");
							const b64 = comma >= 0 ? result.slice(comma + 1) : result;
							const format = recordMimeRef.current.includes("mp4") ? "mp4"
								: recordMimeRef.current.includes("wav") ? "wav"
								: recordMimeRef.current.includes("ogg") ? "ogg"
								: "webm";
							try {
								// 125s: the cli transcriber itself allows 120s and the
								// first call may pay a local-model load.
								const resp = await sendCommandAwait<{ text: string; provider: string }>(
									{ type: "transcribe_audio", audioB64: b64, format, durationMs },
									125_000,
								);
								const text = resp.data?.text;
								if (text) {
									setInput((prev) => (prev ? prev.trimEnd() + " " : "") + text);
								}
							} catch (sidecarErr) {
								const msg = sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr);
								// Only fall back to the Rust bridge (OpenAI whisper-1) when
								// the sidecar reports no voice pipeline — timeouts and
								// transcription errors are surfaced as-is.
								if (/not configured/i.test(msg)) {
									try {
										const { invoke } = await import("@tauri-apps/api/core");
										const text = await invoke<string>("transcribe_audio", {
											audioB64: b64,
											mimeType: recordMimeRef.current,
										});
										if (text) {
											setInput((prev) => (prev ? prev.trimEnd() + " " : "") + text);
										}
									} catch (rustErr) {
										console.error("[composer] transcribe fallback failed:", rustErr);
										setVoiceError(rustErr instanceof Error ? rustErr.message : String(rustErr));
									}
								} else {
									console.error("[composer] transcribe failed:", sidecarErr);
									setVoiceError(msg);
								}
							} finally {
								setTranscribing(false);
							}
						};
						reader.onerror = () => setTranscribing(false);
						reader.readAsDataURL(blob);
					};
					mediaRecorderRef.current = recorder;
					recordStartRef.current = Date.now();
					setVoiceError(null);
					setInterimText("");
					setRecordSecs(0);
					setRecording(true);
					recorder.start(250);
				} catch (e) {
					console.error("[composer] mic access failed:", e);
					teardownAudio();
					setRecording(false);
					setTranscribing(false);
					setVoiceError(e instanceof Error ? e.message : String(e));
				}
			})();
			return;
		}

		// Browser: use Web Speech API for real-time dictation.
		const win = window as unknown as {
			SpeechRecognition?: new () => SpeechRecognition;
			webkitSpeechRecognition?: new () => SpeechRecognition;
		};
		const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition;
		if (!SR) return;

		const recognition = new SR();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";

		recognition.onresult = (event: SpeechRecognitionEvent) => {
			let final = "";
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result[0]?.transcript ?? "";
				if (result.isFinal && text) {
					final += (final ? " " : "") + text;
				} else {
					interim += text;
				}
			}
			setInterimText(interim);
			if (final) {
				setInput((prev) => (prev ? prev.trimEnd() + " " : "") + final);
				setInterimText("");
			}
		};

		recognition.onerror = () => setRecording(false);
		recognition.onend = () => setRecording(false);

		recognitionRef.current = recognition;
		recordStartRef.current = Date.now();
		setVoiceError(null);
		setInterimText("");
		setRecordSecs(0);
		setRecording(true);
		recognition.start();
	}, [attachLevelMeter, teardownAudio]);

	const stopRecording = useCallback(() => {
		if (isTauri()) {
			const recorder = mediaRecorderRef.current;
			if (recorder && recorder.state !== "inactive") {
				setRecording(false);
				setInterimText("");
				setTranscribing(true);
				recorder.stop();
			}
			return;
		}
		recognitionRef.current?.stop();
	}, []);

	/** Drop the in-progress clip entirely (Esc / ✕). */
	const cancelRecording = useCallback(() => {
		if (isTauri()) {
			const recorder = mediaRecorderRef.current;
			if (recorder && recorder.state !== "inactive") {
				recordCancelledRef.current = true;
				setRecording(false);
				setTranscribing(false);
				recorder.stop(); // onstop sees the flag and discards the blob
				return;
			}
			setRecording(false);
			setTranscribing(false);
			teardownAudio();
			return;
		}
		// abort() discards pending results without emitting them — absent
		// from the DOM lib's older SpeechRecognition typing, so call loosely.
		(recognitionRef.current as unknown as { abort?: () => void } | null)?.abort?.();
		setRecording(false);
	}, [teardownAudio]);

	// Elapsed timer while recording; auto-stop at 2min so an unattended
	// session can't hold the mic open forever.
	useEffect(() => {
		if (!recording) return;
		const iv = window.setInterval(() => {
			const secs = Math.floor((Date.now() - recordStartRef.current) / 1000);
			setRecordSecs(secs);
			if (secs >= 120) stopRecording();
		}, 250);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				cancelRecording();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			window.clearInterval(iv);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [recording, stopRecording, cancelRecording]);

	// Voice errors self-dismiss.
	useEffect(() => {
		if (!voiceError) return;
		const t = window.setTimeout(() => setVoiceError(null), 8000);
		return () => window.clearTimeout(t);
	}, [voiceError]);

	const addFiles = useCallback(async (files: FileList | File[]) => {
		// Image attachments stay as base64 inline attachments; anything else
		// becomes a path reference the agent can read back with its file tools.
		const list = Array.from(files);
		const results = await Promise.all(list.map(loadFileAttachment));
		const nextImages: ComposerImage[] = [];
		const nextFiles: LoadedFileAttachment[] = [];
		const nextRejected: RejectedAttachment[] = [];
		for (const r of results) {
			if (r.kind === "image") {
				nextImages.push({
					data: r.data,
					mimeType: r.mimeType,
					name: r.name,
					preview: r.preview,
				});
			} else if (r.kind === "file") {
				nextFiles.push(r);
			} else {
				nextRejected.push(r);
			}
		}
		if (nextImages.length > 0) setImages((prev) => [...prev, ...nextImages]);
		if (nextFiles.length > 0) setFiles((prev) => [...prev, ...nextFiles]);
		if (nextRejected.length > 0) setRejected((prev) => [...prev, ...nextRejected]);
	}, []);

	const addPathFiles = useCallback(async (paths: string[]) => {
		const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
		if (uniquePaths.length === 0) return;
		try {
			const nextFiles = await loadPathAttachments(uniquePaths);
			if (nextFiles.length > 0) {
				setFiles((prev) => {
					const seen = new Set(prev.map((file) => file.absolutePath));
					return [
						...prev,
						...nextFiles.filter((file) => {
							if (seen.has(file.absolutePath)) return false;
							seen.add(file.absolutePath);
							return true;
						}),
					];
				});
			}
		} catch (e) {
			setRejected((prev) => [
				...prev,
				{
					kind: "rejected",
					name: uniquePaths.length === 1 ? uniquePaths[0] : `${uniquePaths.length} files`,
					size: 0,
					mimeType: "",
					reason: e instanceof Error ? e.message : String(e),
				},
			]);
		}
	}, []);

	// Handle mention selection: replace `@query` in the input with the
	// mention's insert text, and for file mentions also add the file as an
	// attachment so the agent can read it.
	const handleMentionSelect = useCallback(
		(item: MentionItem) => {
			closeMention();
			setMentionQuery("");
			setMentionStart(-1);

			// For file mentions, add the file as an attachment (same as drag-drop).
			if (item.category === "file" && item.absolutePath) {
				void addPathFiles([item.absolutePath]);
			}

			// Replace `@query` in the input with the insert text. A trailing space
			// is appended so that typing right after an inserted mention does not
			// re-open the menu on the just-inserted `@token` (its query would be
			// the token text, showing only that item again).
			setInput((prev) => {
				if (mentionStart < 0) return prev;
				const before = prev.slice(0, mentionStart);
				const after = prev.slice(mentionStart + 1 + mentionQuery.length);
				const insert = `${item.insertText} `;
				const next = `${before}${insert}${after}`;
				// Restore focus and place cursor after the inserted text.
				requestAnimationFrame(() => {
					const el = textareaRef.current;
					if (el) {
						const pos = before.length + insert.length;
						el.focus();
						el.setSelectionRange(pos, pos);
					}
				});
				return next;
			});
		},
		[mentionStart, mentionQuery, addPathFiles, closeMention],
	);

	useEffect(() => {
		if (!sidecarReady || !isTauri()) return;
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		let unlistenNative: (() => void) | undefined;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			unlistenNative = await listen<{ paths?: string[] }>("native_file_drop", (event) => {
				if (cancelled) return;
				setIsDragOver(false);
				void addPathFiles(event.payload.paths ?? []);
			});
			const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
			unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
				if (cancelled) return;
				const payload = event.payload as { type?: string; paths?: string[] };
				if (payload.type === "enter" || payload.type === "over") {
					setIsDragOver(true);
					return;
				}
				if (payload.type === "leave") {
					setIsDragOver(false);
					return;
				}
				if (payload.type === "drop") {
					setIsDragOver(false);
					void addPathFiles(payload.paths ?? []);
				}
			});
		})().catch((e) => {
			console.error("[composer] tauri drag-drop listener failed:", e);
		});
		return () => {
			cancelled = true;
			unlisten?.();
			unlistenNative?.();
		};
	}, [sidecarReady, addPathFiles]);

	// Listen for prefill requests from other parts of the UI (e.g. the Git tab's
	// read-only branch list offering to switch in chat). Scoped to this
	// workspace so a prefill meant for another workspace is ignored.
	useEffect(() => {
		const onPrefill = (e: Event) => {
			const detail = (e as CustomEvent<ComposerPrefillDetail>).detail;
			if (!detail || !samePath(detail.workspace, workspace ?? "")) return;
			setInput((prev) => (prev.trim() ? prev.trimEnd() + " " : "") + detail.text);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener(COMPOSER_PREFILL_EVENT, onPrefill as EventListener);
		return () => window.removeEventListener(COMPOSER_PREFILL_EVENT, onPrefill as EventListener);
	}, [workspace]);

	// --- Drag-and-drop wiring ----------------------------------------------
	// We listen on the outer composer wrapper (not the textarea) so users can
	// drop files anywhere over the prompt area. The textarea still owns its
	// own paste handler for clipboard images and direct file drops.
	const onDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
		if (!sidecarReady) return;
		if (!Array.from(e.dataTransfer.types).includes("Files")) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}, [sidecarReady]);

	const onDragEnter = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
		if (!sidecarReady) return;
		if (!Array.from(e.dataTransfer.types).includes("Files")) return;
		e.preventDefault();
		// dragenter/dragleave fire on every descendant boundary, so we count
		// depth to avoid flickering the overlay as the cursor crosses children.
		dragDepthRef.current += 1;
		if (dragDepthRef.current === 1) setIsDragOver(true);
	}, [sidecarReady]);

	const onDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
		if (!sidecarReady) return;
		e.preventDefault();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) setIsDragOver(false);
	}, [sidecarReady]);

	const onDrop = useCallback(
		(e: ReactDragEvent<HTMLDivElement>) => {
			if (!sidecarReady) return;
			const dropped = e.dataTransfer?.files;
			if (!dropped || dropped.length === 0) return;
			e.preventDefault();
			dragDepthRef.current = 0;
			setIsDragOver(false);
			void addFiles(dropped);
		},
		[sidecarReady, addFiles],
	);



	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (e.target.files) void addFiles(e.target.files);
			e.target.value = "";
		},
		[addFiles],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = Array.from(e.clipboardData.files);
			if (files.length > 0) {
				e.preventDefault();
				void addFiles(files);
			}
		},
		[addFiles],
	);

	const removeImage = useCallback((index: number) => {
		setImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const removeFile = useCallback((index: number) => {
		setFiles((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const dismissRejected = useCallback((index: number) => {
		setRejected((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const clearRejected = useCallback(() => {
		setRejected([]);
	}, []);

	// Reveal a file in the OS file manager (Finder on macOS, Explorer on
	// Windows, the desktop file manager on Linux). Calls into the Tauri
	// bridge's reveal_file IPC command, which spawns the platform opener.
	// No-op in the browser.
	const revealInFinder = useCallback((absolutePath: string) => {
		if (typeof window === "undefined") return;
		const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
		if (!w.__TAURI_INTERNALS__) return;
		void invoke("reveal_file", { absolutePath }).catch(() => {
			/* swallow — path may not exist or opener may be unavailable */
		});
	}, []);

	const handleSend = () => {
		const message = input.trim();
		if (!sidecarReady) return;

		// `/` builtin — intercepted locally like the TUI's builtin dispatch.
		// Non-builtin `/name args` falls through to onSend so the agent can
		// run extension commands and expand skills/prompt templates.
		const slash = message ? parseSlashInput(message) : null;
		if (slash) {
			const def = DESKTOP_BUILTIN_COMMANDS.find((d) => d.name === slash.name);
			if (def) {
				setInput("");
				void dispatchBuiltin(def.name, slash.args);
				return;
			}
		}

		// `!cmd` — run the shell command locally and show its output card.
		if (message.startsWith("!")) {
			const command = message.slice(message.startsWith("!!") ? 2 : 1).trim();
			if (command) {
				if (!bashRunning) {
					setInput("");
					setImages([]);
					setFiles([]);
					void runBashCommand(command);
				}
				return;
			}
		}

		// Pass images and files through as separate RPC fields — the user
		// message text is sent verbatim. Image attachments go through the
		// dedicated `images` field; non-image files are path references
		// the agent reads back with its own file tools (read, bash, etc.).
		const outgoingImages = images.length > 0 ? images : undefined;
		const outgoingFiles = files.length > 0 ? files : undefined;
		if ((!message && !outgoingImages && !outgoingFiles) || !sidecarReady) return;
		if (recording || transcribing) return; // the recording bar owns the input
		onSend(message, outgoingImages, outgoingFiles);
		setInput("");
		setImages([]);
		setFiles([]);
		// Sent — drop the stored draft so it does not reappear after a restart.
		saveDraft(workspace ?? "", { input: "", images: [], files: [] });
	};

	const canSend =
		sidecarReady && !recording && !transcribing && (!!input.trim() || images.length > 0 || files.length > 0);

	return (
		<div className="bg-bg px-6 py-4">
			<div className="mx-auto max-w-3xl">
				<div
					className={cn(
						"relative rounded-2xl border border-border bg-bg px-4 pt-3 pb-2 shadow-[0_1px_6px_rgb(0_0_0/0.04)] transition-colors focus-within:border-muted/70",
						!sidecarReady && "opacity-60",
						isDragOver && "border-accent ring-2 ring-accent/40",
					)}
					onDragEnter={onDragEnter}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
				>
					{isDragOver && (
						<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/10">
							<div className="rounded-full border border-accent/40 bg-surface px-4 py-2 text-xs font-medium text-accent shadow-md">
								{t("composer.dropFiles")}
							</div>
						</div>
					)}
					{(images.length > 0 || files.length > 0) && (
						<div className="mb-2 flex flex-wrap gap-2">
							{images.map((img, i) => (
								<div
									key={`${img.name}-${i}`}
									className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border"
								>
									<img
										src={img.preview}
										alt={img.name}
										className="h-full w-full object-cover"
									/>
									<button
										type="button"
										onClick={() => removeImage(i)}
										className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
										title={t("common.remove")}
									>
										<X className="h-3 w-3" />
									</button>
								</div>
							))}
							{files.map((f, i) => (
								<div
									key={f.absolutePath}
									className="group flex h-9 w-48 items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface-2 px-2.5 text-xs"
									title={f.absolutePath}
								>
									<FileAttachmentIcon name={f.name} mimeType={f.mimeType} />
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-fg">{f.name}</span>
										{f.size > 0 && (
											<span className="truncate text-[10px] text-muted">{formatFileSize(f.size)}</span>
										)}
									</div>
									<button
										type="button"
										onClick={() => revealInFinder(f.absolutePath)}
										className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-bg/60 hover:text-fg"
										title={t("composer.revealInFinder")}
									>
										<FolderOpen className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										onClick={() => removeFile(i)}
										className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-bg/60 hover:text-fg"
										title={t("common.remove")}
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</div>
							))}
						</div>
					)}
					{bashResult && (
						<div className="mb-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="flex min-w-0 items-center gap-1.5 font-medium text-fg">
									<Terminal className="h-3.5 w-3.5 shrink-0 text-muted" />
									<ChevronRight className="h-3 w-3 shrink-0 text-muted" />
									<span className="truncate font-mono">{bashResult.command}</span>
								</span>
								<span className="flex shrink-0 items-center gap-2">
									{bashRunning ? (
										<span className="flex items-center gap-1 text-muted">
											<Loader2 className="h-3 w-3 animate-spin" />
											{t("slash.bashRunning")}
										</span>
									) : (
										<>
											{bashResult.cancelled ? (
												<span className="text-warning">{t("slash.bashCancelled")}</span>
											) : bashResult.exitCode !== undefined && bashResult.exitCode !== 0 ? (
												<span className="text-danger">{t("slash.bashExitCode", { code: bashResult.exitCode })}</span>
											) : null}
										</>
									)}
									<button
										type="button"
										onClick={() => setBashResult(null)}
										className="text-muted hover:text-fg"
										title={t("common.dismiss")}
									>
										<X className="h-3 w-3" />
									</button>
								</span>
							</div>
							{(bashRunning || bashResult.output) && (
								<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted">
									{bashResult.output || " "}
								</pre>
							)}
							{bashResult.truncated && (
								<div className="mt-1 text-[10px] text-warning">{t("slash.bashTruncated")}</div>
							)}
						</div>
					)}
					{rejected.length > 0 && (
						<div className="mb-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">
									{t("composer.rejectedFiles", { count: rejected.length })}
								</span>
								<button
									type="button"
									onClick={clearRejected}
									className="text-warning/70 hover:text-warning"
									title={t("common.dismiss")}
								>
									<X className="h-3 w-3" />
								</button>
							</div>
							<ul className="mt-1 space-y-0.5">
								{rejected.map((r, i) => (
									<li key={`${r.name}-${i}`} className="flex items-center gap-1.5 truncate text-warning/80">
										<span className="truncate">{r.name}</span>
										<span className="shrink-0 text-warning/60">— {r.reason}</span>
										<button
											type="button"
											onClick={() => dismissRejected(i)}
											className="ml-auto shrink-0 text-warning/60 hover:text-warning"
											title={t("common.dismiss")}
										>
											<X className="h-3 w-3" />
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					{compacting && (
						<div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-accent">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							<span>{t("slash.compacting")}</span>
						</div>
					)}
					{voiceError && (
						<div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
							<span className="truncate">{voiceError}</span>
							<button
								type="button"
								onClick={() => setVoiceError(null)}
								className="shrink-0 rounded p-0.5 transition-colors hover:bg-danger/10"
								title={t("common.dismiss")}
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					)}
					<div className="relative">
						{recording || transcribing ? (
							<div className="flex min-h-[2.5rem] items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2">
								{recording ? (
									<>
										<button
											type="button"
											onClick={cancelRecording}
											className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-fg"
											title={t("composer.cancelRecording")}
										>
											<X className="h-3.5 w-3.5" />
										</button>
										<span className="relative flex h-2.5 w-2.5 shrink-0">
											<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
											<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
										</span>
										{interimText ? (
											<span className="min-w-0 flex-1 truncate text-sm italic text-muted">{interimText}</span>
										) : (
											<div className="flex h-4 flex-1 items-center gap-[3px]" aria-hidden>
												{[0.4, 0.75, 1, 0.75, 0.4].map((f, i) => (
													<span
														key={i}
														className="w-[3px] rounded-full bg-danger/70 transition-[height] duration-100"
														style={{ height: `${Math.max(3, Math.round(recordLevel * 16 * f))}px` }}
													/>
												))}
											</div>
										)}
										<span className="shrink-0 font-mono text-xs tabular-nums text-danger">
											{Math.floor(recordSecs / 60)}:{String(recordSecs % 60).padStart(2, "0")}
										</span>
										<button
											type="button"
											onClick={stopRecording}
											className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger text-white transition-colors hover:opacity-90"
											title={t("composer.finishRecording")}
										>
											<Check className="h-3.5 w-3.5" />
										</button>
									</>
								) : (
									<>
										<Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
										<span className="flex-1 text-sm text-muted">{t("composer.transcribing")}</span>
									</>
								)}
							</div>
						) : (
						<textarea
							ref={textareaRef}
							className="w-full resize-none bg-transparent px-1 py-1 text-sm text-fg outline-none placeholder:text-muted min-h-[2.5rem] max-h-80"
							placeholder={sidecarReady ? t("composer.placeholder") : t("composer.waitingForSidecar")}
							value={input}
							disabled={!sidecarReady}
							onChange={(e) => {
								setInput(e.target.value);
								detectMention(e.target.value, e.target.selectionStart ?? 0);
								detectSlash(e.target.value, e.target.selectionStart ?? 0);
							}}
							onKeyUp={(e) => {
								// Re-detect on cursor movement keys (arrows, Home, End).
								if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
									detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
									detectSlash(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
								}
							}}
							onClick={(e) => {
								// Clicking moves the cursor — re-evaluate mention state.
								detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
								detectSlash(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
							}}
							onPaste={handlePaste}
							onKeyDown={(e) => {
								// Slash menu is open while the cursor is inside the leading
								// `/command` token — it owns the nav/commit keys first.
								if (slashActiveRef.current) {
									const filtered = filteredSlashItemsRef.current;
									if (e.key === "Escape") {
										e.preventDefault();
										closeSlash();
										return;
									}
									if (filtered.length > 0) {
										if (e.key === "ArrowDown") {
											e.preventDefault();
											e.stopPropagation();
											setSlashSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											e.stopPropagation();
											setSlashSelectedIndex((prev) => Math.max(prev - 1, 0));
											return;
										}
										if (e.key === "Tab") {
											e.preventDefault();
											e.stopPropagation();
											const idx = Math.min(slashSelectedIndexRef.current, filtered.length - 1);
											const item = filtered[idx];
											if (item) handleSlashSelect(item);
											return;
										}
										// Enter falls through to handleSend when the input is
										// already a complete command; otherwise complete the
										// highlighted item like Tab does.
										if (e.key === "Enter" && !e.shiftKey) {
											const parsed = parseSlashInput(input);
											const exact = filtered.find((i) => i.name === parsed?.name);
											if (!exact) {
												e.preventDefault();
												e.stopPropagation();
												const idx = Math.min(slashSelectedIndexRef.current, filtered.length - 1);
												const item = filtered[idx];
												if (item) handleSlashSelect(item);
												return;
											}
										}
									}
								}
								// When the mention menu is open, intercept navigation keys.
								// Use refs to read the latest state — the inline handler
								// closure can be stale if it was created during a render
								// where the filtered list was still empty (data loading).
								if (mentionActiveRef.current) {
									const filtered = filteredMentionItemsRef.current;
									// Escape always closes the menu, even with no matches.
									if (e.key === "Escape") {
										e.preventDefault();
										closeMention();
										return;
									}
									// Only claim the navigation/commit keys when there is
									// something to navigate or commit. With zero matches the
									// keys must fall through, otherwise an open-but-empty menu
									// swallows Enter and the message can never be sent.
									if (filtered.length > 0) {
										if (e.key === "ArrowDown") {
											e.preventDefault();
											e.stopPropagation();
											setMentionSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											e.stopPropagation();
											setMentionSelectedIndex((prev) => Math.max(prev - 1, 0));
											return;
										}
										if (e.key === "Enter" || e.key === "Tab") {
											e.preventDefault();
											e.stopPropagation();
											const idx = Math.min(mentionSelectedIndexRef.current, filtered.length - 1);
											const item = filtered[idx];
											if (item) handleMentionSelect(item);
											return;
										}
									}
								}
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									handleSend();
								}
							}}
						/>
						)}
						{mentionActive && (
							<MentionMenu
								items={filteredMentionItems}
								selectedIndex={mentionSelectedIndex}
								onSelect={handleMentionSelect}
								onNavigate={setMentionSelectedIndex}
							/>
						)}
						{slashActive && (
							<SlashMenu
								items={filteredSlashItems}
								selectedIndex={slashSelectedIndex}
								onSelect={handleSlashSelect}
								onNavigate={setSlashSelectedIndex}
							/>
						)}
					</div>
					<div className="mt-1 flex items-center justify-between gap-2">
						{/* Left cluster */}
						<div className="flex items-center gap-1">
							{/* + button: multi-action menu (new session, attach, skills) */}
							<input
								ref={fileInputRef}
								type="file"
								multiple
								className="hidden"
								onChange={handleFileChange}
							/>
							<div className="relative" ref={plusMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady}
									onClick={() => setPlusMenuOpen((o) => !o)}
									className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
									title={t("composer.add")}
								>
									<Plus className="h-4 w-4" />
								</button>
								{plusMenuOpen && (
									<div className={cn("absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-border bg-surface p-1 shadow-xl", Z.menu)}>
										<button
											type="button"
											onClick={() => void handleNewSession()}
											className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2"
										>
											<MessageSquarePlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
											<span className="min-w-0 flex-1">
												<span className="block text-fg">{t("composer.newSession")}</span>
												<span className="block text-[10px] text-muted">{t("composer.newSessionHint")}</span>
											</span>
										</button>
										<button
											type="button"
											onClick={() => {
												setPlusMenuOpen(false);
												fileInputRef.current?.click();
											}}
											className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2"
										>
											<Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
											<span className="min-w-0 flex-1">
												<span className="block text-fg">{t("composer.attachFiles")}</span>
												<span className="block text-[10px] text-muted">{t("composer.attachFilesHint")}</span>
											</span>
										</button>
										{/* Scheduled tasks — opens the schedule popover next door */}
										<button
											type="button"
											onClick={() => {
												setPlusMenuOpen(false);
												setScheduleMenuOpen(true);
											}}
											className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2"
										>
											<Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
											<span className="min-w-0 flex-1">
												<span className="block text-fg">{t("composer.scheduledTask")}</span>
												<span className="block text-[10px] text-muted">{t("composer.scheduledTaskHint")}</span>
											</span>
										</button>
										{skills.length > 0 && (
											<>
												<div className="my-1 border-t border-border/60" />
												<div className="px-2.5 py-1 text-[11px] font-medium text-muted">
													{t("composer.skills")}
												</div>
												<div className="max-h-52 overflow-y-auto">
													{skills.map((s) => (
														<button
															key={s.command}
															type="button"
															onClick={() => handleInsertSkill(s.command)}
															title={s.description}
															className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-2"
														>
															<Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
															<span className="min-w-0 flex-1">
																<span className="block truncate text-fg">{s.name}</span>
																{s.description && (
																	<span className="block truncate text-[10px] text-muted">{s.description}</span>
																)}
															</span>
														</button>
													))}
												</div>
											</>
										)}
									</div>
							)}
							</div>
							{/* Scheduled tasks — popover with this workspace's tasks + inline editor */}
							<ScheduleMenu
								workspace={workspace}
								disabled={!sidecarReady}
								open={scheduleMenuOpen}
								onOpenChange={setScheduleMenuOpen}
							/>
							{/* Approval policy selector — chooses safe mode for the current session */}
							<div className="relative" ref={approvalMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady}
									onClick={() => setApprovalMenuOpen((o) => !o)}
									className={cn(
										"flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
										gated
											? "text-warning hover:bg-surface"
											: "text-muted hover:bg-surface hover:text-fg",
									)}
									title={t("composer.approvalPolicy")}
								>
									{gated ? (
										<ShieldCheck className="h-3.5 w-3.5" />
									) : (
										<Shield className="h-3.5 w-3.5" />
									)}
									<span>{gated ? t("composer.approvalGated") : t("composer.approvalOff")}</span>
									<ChevronDown className="h-3 w-3" />
								</button>
								{approvalMenuOpen && (
									<div className={cn("absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}>
										{([
											{ policy: "auto" as const, icon: ShieldCheck, label: t("composer.approvalGated"), hint: t("composer.approvalGatedHint"), active: gated },
											{ policy: "off" as const, icon: Shield, label: t("composer.approvalOff"), hint: t("composer.approvalOffHint"), active: !gated },
										] as const).map(({ policy, icon: Icon, label, hint, active }) => (
											<button
												key={policy}
												type="button"
												onClick={() => void handleApprovalPolicyChange(policy)}
												className={cn(
													"flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2",
													active ? "text-fg" : "text-muted",
												)}
											>
												<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
												<span className="min-w-0 flex-1">
													<span className="block text-fg">{label}</span>
													<span className="block text-[10px] text-muted">{hint}</span>
												</span>
												{active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
											</button>
										))}
									</div>
								)}
							</div>
						</div>

						{/* Right cluster */}
						<div className="flex items-center gap-1">
							{/* Context usage ring — shows current context window occupancy */}
							<ContextRing
								contextUsage={state?.contextUsage}
								tokenUsage={state?.tokenUsage}
							/>

							{/* Model selector */}
							<div className="relative" ref={modelMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady || visibleModels.length === 0}
									onClick={() => setModelMenuOpen((o) => !o)}
									className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
									title={visibleModels.length === 0 ? t("composer.noModelsAvailable") : t("composer.selectModel")}
								>
									<span className="max-w-[10rem] truncate">{currentModelLabel}</span>
									<ChevronDown className="h-3.5 w-3.5" />
								</button>
								{modelMenuOpen && visibleModels.length > 0 && (
									<div className={cn("absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}>
										{/* Search — autofocused on open; ↑/↓+Enter pick from the filtered list */}
										<div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 pb-1.5">
											<Search className="h-3.5 w-3.5 shrink-0 text-muted" />
											<input
												ref={modelSearchRef}
												value={modelQuery}
												onChange={(e) => {
													setModelQuery(e.target.value);
													setModelMenuIndex(0);
												}}
												onKeyDown={(e) => {
													if (e.key === "ArrowDown") {
														e.preventDefault();
														setModelMenuIndex((i) => Math.min(i + 1, filteredModels.length - 1));
													} else if (e.key === "ArrowUp") {
														e.preventDefault();
														setModelMenuIndex((i) => Math.max(i - 1, 0));
													} else if (e.key === "Enter") {
														e.preventDefault();
														const m = filteredModels[Math.min(modelMenuIndex, filteredModels.length - 1)];
														if (m) void handleModelSelect(m);
													} else if (e.key === "Escape") {
														e.preventDefault();
														setModelMenuOpen(false);
														textareaRef.current?.focus();
													}
												}}
												placeholder={t("composer.searchModels")}
												className="w-full bg-transparent py-1 text-xs text-fg outline-none placeholder:text-muted"
											/>
										</div>
										<div className="max-h-64 overflow-y-auto pt-1">
											{filteredModels.length === 0 ? (
												<div className="px-2.5 py-2 text-[11px] text-muted">{t("composer.noModelMatches")}</div>
											) : (
												filteredModels.map((m, i) => {
													const key = `${m.provider}:${m.id}`;
													const selected = displayedModel
														? m.provider === displayedModel.provider && m.id === displayedModel.id
														: false;
													const highlighted = i === modelMenuIndex;
													return (
														<button
															key={key}
															ref={(el) => {
																if (el) modelItemRefs.current.set(i, el);
															}}
															type="button"
															onClick={() => handleModelSelect(m)}
															onMouseMove={() => setModelMenuIndex(i)}
															className={cn(
																"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
																highlighted ? "bg-surface-2" : "hover:bg-surface-2",
																selected ? "text-fg" : "text-muted",
															)}
														>
															<span className="min-w-0 flex-1">
																<span className="block truncate text-fg">{m.name}</span>
																<span className="block truncate text-[10px] text-muted">
																	{m.provider}
																</span>
															</span>
															{selected ? (
																<Check className="h-3.5 w-3.5 shrink-0 text-accent" />
															) : null}
														</button>
													);
												})
											)}
										</div>
									{/* Thinking level — controls reasoning effort for the current model */}
									<div className="mt-1 border-t border-border/60 pt-1">
										<div className="px-2.5 py-1 text-[11px] font-medium text-muted">
											{t("composer.thinkingLevel")}
										</div>
										<div className="flex flex-wrap gap-1 px-1.5 pb-1">
											{THINKING_LEVELS.map((level) => (
												<button
													key={level}
													type="button"
													onClick={() => void handleThinkingChange(level)}
													className={cn(
														"rounded-md px-2 py-0.5 text-[11px] transition-colors",
														currentThinking === level
															? "bg-accent/15 text-accent"
															: "text-muted hover:bg-surface-2 hover:text-fg",
													)}
												>
													{level}
												</button>
											))}
										</div>
									</div>
								</div>
							)}
							{modelMenuOpen && visibleModels.length === 0 && modelTotal > 0 && (
									<div className={cn("absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}>
										<a
											href="/#/settings"
											className="block rounded-lg bg-surface-2 px-2.5 py-1.5 text-center text-[11px] text-accent hover:opacity-80"
										>
											{t("composer.configureApiKey")}
										</a>
									</div>
								)}
							</div>

							{/* Mic */}
							<button
								type="button"
								disabled={!hasSpeechSupport || !sidecarReady || transcribing}
								onClick={recording ? stopRecording : startRecording}
								className={cn(
									"flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40",
									recording
										? "bg-danger/10 text-danger"
										: transcribing
											? "text-accent"
											: "text-muted hover:bg-surface hover:text-fg",
								)}
								title={
									transcribing
										? t("composer.transcribing")
										: recording
											? t("composer.finishRecording")
											: t("composer.voiceInput")
								}
							>
								{transcribing ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : recording ? (
									<Square className="h-3.5 w-3.5 fill-current" />
								) : (
									<Mic className="h-4 w-4" />
								)}
							</button>

							{/* Send / Stop */}
							{isRunning ? (
								<button
									type="button"
									onClick={onAbort}
									className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white transition-colors hover:opacity-90"
									title={t("composer.stop")}
								>
									<Square className="h-3.5 w-3.5" />
								</button>
							) : (
								<button
									type="button"
									onClick={handleSend}
									disabled={!canSend}
									className={cn(
										"flex h-8 w-8 items-center justify-center rounded-full transition-colors",
										canSend
											? "bg-accent text-accent-fg hover:opacity-90"
											: "bg-border text-muted",
									)}
									title={t("composer.send")}
								>
									<ArrowUp className="h-4 w-4" />
								</button>
							)}
						</div>
					</div>
				</div>
				<div className="mt-2 text-center text-[11px] text-muted">
					{t("composer.sendHint")}
				</div>
			</div>
			<Modal
				open={exportResult !== null}
				onClose={() => setExportResult(null)}
				title={t("slash.exportDone")}
				size="md"
				footer={
					<>
						<button
							type="button"
							onClick={() => {
								if (exportResult) revealInFinder(exportResult.path);
								setExportResult(null);
							}}
							className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2/80"
						>
							{t("composer.revealInFinder")}
						</button>
						<button
							type="button"
							onClick={() => setExportResult(null)}
							className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent transition-colors hover:bg-accent/25"
						>
							{t("common.confirm")}
						</button>
					</>
				}
			>
				<p className="break-all font-mono text-xs">{exportResult?.path}</p>
			</Modal>
		</div>
	);
}
