/**
 * BrowserPane — the in-app browser panel (IAB mirror).
 *
 * Hosted as a RightDock tab. Lifecycle:
 *  - mount: fetch browser_get_state (authoritative source for tabs + frame
 *    credentials), connect the frame channel, tell the sidecar the panel is
 *    visible (starts the screencast of the active tab)
 *  - unmount: panel invisible (screencast pauses), frame channel closed
 *
 * All control operations (navigate / close tab / emergency stop) go through
 * the RPC command path; the WebSocket carries frames down and input up.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { dispatchWebElementContextAdd } from "@/lib/web-element-contexts";
import {
	buildCancelWebElementPickerScript,
	buildWebElementPickerScript,
	type WebElementContextPayload,
	type WebElementPickerScriptResult,
} from "@/lib/web-element-picker";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Bug, Globe, Loader2, MousePointerClick, OctagonX, Plus, RotateCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { RpcBrowserFrameMessage, RpcBrowserState, RpcBrowserTab } from "@tomsun28/pizza-protocol";
import { sendCommandAwait, subscribeEvents } from "@/lib/transport";
import { BrowserFrameClient, type FrameClientStatus, type PushedFrame } from "@/lib/browser-frame-client";
import { cn } from "@/lib/utils";
import { isRemoteWorkspaceKey } from "@/lib/platform";
import BrowserViewport from "./BrowserViewport";
import NativeBrowserView, {
	activateNativeTab,
	closeNativeTab,
	execBrowserBridge,
	invokeNative,
	isNativeBrowserAvailable,
	navigateNativeTab,
	openNativeTab,
	type NativeTabPatch,
} from "./NativeBrowserView";

/** Local tab record for the native pane. */
interface NativeTabInfo {
	id: string;
	url: string;
	title: string;
	loading: boolean;
}

/** Sidecar → frontend agent command over the native bridge. */
interface NativeBridgeCommand {
	nonce: string;
	kind: "navigate" | "close" | "exec" | "activate" | "tabs";
	payload?: { url?: string; code?: string; tabId?: string; newTab?: boolean };
}

/** Listen for agent-side native browser commands on the rpc event stream. */
function subscribeBrowserNativeCmd(
	handler: (command: NativeBridgeCommand) => void,
): Promise<() => void> {
	return subscribeEvents((event) => {
		const type = (event as { type?: string }).type;
		if (type !== "BROWSER_NATIVE_CMD") return;
		const payload = (event as { payload?: NativeBridgeCommand }).payload;
		if (payload?.nonce) handler(payload);
	});
}

async function fetchBrowserState(): Promise<RpcBrowserState | undefined> {
	try {
		const response = await sendCommandAwait<RpcBrowserState>({ type: "browser_get_state" });
		if (!response.success) return undefined;
		return response.data ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Mirror implementation — used in the plain-browser (web) build where no
 * child webview exists: a managed Chromium renders the page and this pane
 * mirrors its frames over a local WebSocket.
 */
function MirrorBrowserPane() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<FrameClientStatus>("connecting");
	const [tabs, setTabs] = useState<RpcBrowserTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
	const [agentActive, setAgentActive] = useState(false);
	const [frame, setFrame] = useState<PushedFrame | null>(null);
	const [address, setAddress] = useState("");
	const [engineAvailable, setEngineAvailable] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const clientRef = useRef<BrowserFrameClient | null>(null);

	// Keep the latest activeTabId accessible in stable callbacks.
	const activeTabIdRef = useRef<string | undefined>(undefined);
	activeTabIdRef.current = activeTabId;
	// Timestamp of the last emergency stop — late failures of in-flight
	// navigations it killed ("Target page, context or browser has been
	// closed") are expected noise, not actionable errors.
	const stoppedAtRef = useRef(0);

	const handleFrameMessage = useCallback((message: RpcBrowserFrameMessage) => {
		switch (message.type) {
			case "tabs":
				setTabs(message.tabs);
				break;
			case "tab_activated":
				setActiveTabId(message.tabId);
				setFrame(null);
				break;
			case "tab_closed":
				setFrame(null);
				break;
			case "agent_active":
				setAgentActive(message.active);
				break;
			case "navigated":
				setTabs((prev) =>
					prev.map((tab) => (tab.id === message.tabId ? { ...tab, url: message.url, title: message.title } : tab)),
				);
				if (message.tabId === activeTabIdRef.current) {
					setAddress(message.url);
					// A successful navigation clears any stale error banner.
					setError(undefined);
				}
				break;
			default:
				break;
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		// Coalesce pushed frames with requestAnimationFrame: the screencast can
		// push ~60fps and per-frame setState + JPEG decode would burn a core.
		// Only the latest frame per display refresh is committed; superseded
		// frames are never decoded. A timer backstop commits the frame even
		// when rAF is paused (minimized window / throttled webview) so the
		// mirror never freezes on a stale frame.
		let latestFrame: PushedFrame | null = null;
		let rafId = 0;
		let timerId: ReturnType<typeof setTimeout> | undefined;
		let commitScheduled = false;

		const commitFrame = (): void => {
			commitScheduled = false;
			if (!cancelled) setFrame(latestFrame);
		};
		const scheduleCommit = (): void => {
			if (commitScheduled) return;
			commitScheduled = true;
			rafId = requestAnimationFrame(commitFrame);
			timerId = setTimeout(() => {
				cancelAnimationFrame(rafId);
				commitFrame();
			}, 200);
		};

		const client = new BrowserFrameClient({
			fetchCredentials: async () => (await fetchBrowserState())?.frame,
			onMessage: (message) => {
				if (!cancelled) handleFrameMessage(message);
			},
			onFrame: (pushed) => {
				if (cancelled) return;
				latestFrame = pushed;
				setEngineAvailable(true);
				scheduleCommit();
			},
			onStatusChange: (next) => {
				if (cancelled) return;
				setStatus(next);
				if (next === "open") setError(undefined);
			},
		});
		clientRef.current = client;

		// Single browser_get_state on mount feeds BOTH the panel state and the
		// frame credentials — a second concurrent fetch would issue another
		// token and (pre-multi-token servers) invalidate the one we connect
		// with, looping the mirror in "connecting".
		void fetchBrowserState().then((state) => {
			if (cancelled) return;
			if (state) {
				setTabs(state.tabs);
				setActiveTabId(state.activeTabId);
				setAgentActive(state.agentActive);
				setEngineAvailable(state.available);
				const active = state.tabs.find((tab) => tab.id === state.activeTabId);
				if (active) setAddress(active.url);
				client.connect(state.frame);
			} else {
				// State fetch failed — let the client fetch credentials itself.
				client.connect();
			}
		});

		void sendCommandAwait({ type: "browser_set_panel_visible", visible: true }).catch(() => {});

		return () => {
			cancelled = true;
			if (commitScheduled) cancelAnimationFrame(rafId);
			if (timerId !== undefined) clearTimeout(timerId);
			client.close();
			clientRef.current = null;
			void sendCommandAwait({ type: "browser_set_panel_visible", visible: false }).catch(() => {});
		};
	}, [handleFrameMessage]);

	const navigate = useCallback(async (url: string) => {
		const target = url.trim();
		if (!target) return;
		setError(undefined);
		// 60s: cold Chromium launch + DNS + page load can legitimately exceed
		// the transport default (15s) on slow networks; the Rust gateway's own
		// rpc timeout is also 60s, so this just aligns the two ends.
		const NAVIGATE_TIMEOUT_MS = 60_000;
		try {
			const response = await sendCommandAwait<{ url?: string }>(
				{ type: "browser_navigate", url: target },
				NAVIGATE_TIMEOUT_MS,
			);
			if (!response.success) {
				const message = typeof response.error === "string" ? response.error : "";
				const killedByStop = Date.now() - stoppedAtRef.current < 3000 && /closed|cancelled/i.test(message);
				if (!killedByStop) {
					setError(message || t("browser.navigationFailed"));
				}
			} else if (response.data?.url) {
				setAddress(response.data.url);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const killedByStop = Date.now() - stoppedAtRef.current < 3000 && /timed out|closed/i.test(message);
			if (!killedByStop) setError(message);
		}
	}, [t]);

	const closeTab = useCallback(async (tabId: string) => {
		try {
			await sendCommandAwait({ type: "browser_close_tab", tabId });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const emergencyStop = useCallback(async () => {
		try {
			stoppedAtRef.current = Date.now();
			await sendCommandAwait({ type: "browser_emergency_stop" });
			setTabs([]);
			setFrame(null);
			setEngineAvailable(false);
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const activeTab = tabs.find((tab) => tab.id === activeTabId);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar: tab chips + emergency stop. */}
			<div className="scrollbar-hide flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5">
				{tabs.length === 0 ? (
					<span className="px-1.5 text-xs text-muted/60">{t("browser.noTabs")}</span>
				) : (
					tabs.map((tab) => (
						<span
							key={tab.id}
							className={cn(
								"group flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
								tab.id === activeTabId ? "bg-surface-2 text-accent" : "text-muted hover:bg-surface-2/60",
							)}
						>
							<button
								onClick={() => clientRef.current?.send({ type: "select_tab", tabId: tab.id })}
								className="max-w-32 truncate"
								title={tab.url}
							>
								{tab.title || tab.origin || tab.id}
							</button>
							<button
								onClick={() => void closeTab(tab.id)}
								className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100"
								title={t("browser.closeTab")}
							>
								<X className="h-3 w-3" />
							</button>
						</span>
					))
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{agentActive && (
						<span
							className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
							title={t("browser.agentActiveHint")}
						>
							<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
							{t("browser.agentActive")}
						</span>
					)}
					<button
						onClick={() => void emergencyStop()}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-muted/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
						title={t("browser.stop")}
					>
						<OctagonX className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{/* Address bar. */}
			<form
				className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2"
				onSubmit={(e) => {
					e.preventDefault();
					void navigate(address);
				}}
			>
				<input
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					placeholder={t("browser.addressPlaceholder")}
					spellCheck={false}
					className="h-7 min-w-0 flex-1 rounded-lg bg-surface-2 px-2.5 text-xs text-fg outline-none placeholder:text-muted/50 focus:ring-1 focus:ring-accent/40"
				/>
				<button
					type="submit"
					className="h-7 shrink-0 rounded-lg bg-surface-2 px-2.5 text-xs text-muted transition-colors hover:text-fg"
				>
					{t("browser.go")}
				</button>
			</form>

			{/* Mirror viewport. */}
			<div className="relative min-h-0 flex-1">
				<BrowserViewport
					frame={frame}
					onInput={(event) => {
						// Omit tabId when unknown so the server falls back to its
						// own active tab (an empty string would be a lookup miss).
						clientRef.current?.send({
							type: "input",
							tabId: activeTabId ?? undefined,
							event,
						});
					}}
				/>
				{error && (
					<div className="absolute inset-x-0 top-0 flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
						<span className="min-w-0 flex-1 break-words">{error}</span>
						<button onClick={() => setError(undefined)} className="shrink-0 rounded p-0.5 hover:bg-red-500/20">
							<X className="h-3 w-3" />
						</button>
					</div>
				)}
				{(!frame || status !== "open") && !error && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/80 text-center backdrop-blur-sm">
						{status === "connecting" ? (
							<>
								<Loader2 className="h-5 w-5 animate-spin text-muted/60" />
								<p className="text-xs text-muted">{t("browser.connecting")}</p>
							</>
						) : tabs.length === 0 ? (
							<>
								<Globe className="h-5 w-5 text-muted/50" />
								<p className="max-w-52 text-xs leading-relaxed text-muted/80">{t("browser.emptyHint")}</p>
								<code className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">_browser open &lt;url&gt;</code>
							</>
						) : status === "error" ? (
							<p className="max-w-52 text-xs leading-relaxed text-muted/80">{t("browser.connectionError")}</p>
						) : (
							<p className="text-xs text-muted/60">{t("browser.panelHidden")}</p>
						)}
					</div>
				)}
			</div>

			{/* Status bar. */}
			<div className="flex h-7 shrink-0 items-center justify-between border-t border-border px-2 text-[10px] text-muted/60">
				<span className="truncate">{activeTab ? activeTab.url : t("browser.statusIdle")}</span>
				<span className="shrink-0">
					{engineAvailable ? t("browser.engineRunning") : t("browser.engineIdle")}
					{frame ? ` · ${frame.width}×${frame.height}` : ""}
				</span>
			</div>
		</div>
	);
}

/**
 * Native implementation — Tauri desktop only, multi-tab. Each tab is a real
 * child webview rendered natively over the pane: no mirroring, native
 * scrolling/input. Agent commands (`_browser …`) arrive as BROWSER_NATIVE_CMD
 * events and run against the active tab via the in-page bridge.
 */
function NativeBrowserPane({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tabs, setTabs] = useState<NativeTabInfo[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
	const [address, setAddress] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [agentActive, setAgentActive] = useState(false);
	const [navCount, setNavCount] = useState(0);
	const [isPicking, setIsPicking] = useState(false);
	const [pickedNotice, setPickedNotice] = useState<string | undefined>(undefined);
	const pickRunRef = useRef(0);
	const [permissionAsk, setPermissionAsk] = useState<{ origin: string; kind: string } | undefined>(undefined);
	const [permPanelOpen, setPermPanelOpen] = useState(false);
	const [permGrants, setPermGrants] = useState<Array<{ origin: string; kind: string }>>([]);
	// Permission kinds surfaced in the per-site panel (macOS WKWebView only
	// calls back mic/camera/screen; the rest stay "ask" placeholders).
	const PERMISSION_KINDS = ["camera", "microphone", "display-capture", "geolocation", "notifications"] as const;
	const tabCounter = useRef(0);

	const activeTab = tabs.find((tab) => tab.id === activeTabId);
	const activeTabIdRef = useRef<string | undefined>(undefined);
	activeTabIdRef.current = activeTabId;
	const tabsRef = useRef<NativeTabInfo[]>([]);
	tabsRef.current = tabs;

	// Origin of the current address (for the per-site permission panel).
	const siteOrigin = (() => {
		try {
			return new URL(address).origin;
		} catch {
			return "";
		}
	})();
	const currentOriginRef = useRef("");
	currentOriginRef.current = siteOrigin;
	const siteGrants = permGrants.filter((g) => g.origin === siteOrigin);

	const handleTabPatch = useCallback((patch: NativeTabPatch) => {
		setTabs((prev) => {
			const index = prev.findIndex((tab) => tab.id === patch.tabId);
			if (index < 0) {
				// Unknown tab (e.g. restored after a reload) — adopt it.
				return [
					...prev,
					{
						id: patch.tabId,
						url: patch.url ?? "",
						title: patch.title ?? "",
						loading: patch.loading ?? false,
					},
				];
			}
			const next = [...prev];
			const tab = next[index]!;
			next[index] = {
				...tab,
				url: patch.url ?? tab.url,
				title: patch.title ?? tab.title,
				loading: patch.loading ?? tab.loading,
			};
			return next;
		});
		setActiveTabId((current) => current ?? patch.tabId);
		if (patch.tabId === activeTabIdRef.current) {
			if (patch.url && patch.url !== "about:blank") setAddress(patch.url);
			if (!patch.loading) setError(undefined);
		}
	}, []);

	const newTabId = (): string => `t${++tabCounter.current}`;

	const openTab = useCallback(async (url: string) => {
		setError(undefined);
		try {
			const id = newTabId();
			await openNativeTab(id, url);
			setTabs((prev) => [...prev, { id, url, title: "", loading: true }]);
			setActiveTabId(id);
			setNavCount(0);
			setAddress(url);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const navigateActive = useCallback(async (url: string) => {
		const target = url.trim();
		if (!target) return;
		setError(undefined);
		const tabId = activeTabIdRef.current;
		if (!tabId) {
			await openTab(target);
			return;
		}
		try {
			await navigateNativeTab(tabId, target);
			setAddress(target);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [openTab]);

	const activate = useCallback(async (tabId: string) => {
		setActiveTabId(tabId);
		setNavCount(0);
		const tab = tabsRef.current.find((entry) => entry.id === tabId);
		setAddress(tab?.url ?? "");
		setError(undefined);
		await activateNativeTab(tabId).catch(() => {});
	}, []);

	const closeTab = useCallback(async (tabId: string) => {
		try {
			const remaining = await closeNativeTab(tabId);
			setTabs((prev) => prev.filter((tab) => tab.id !== tabId));
			setActiveTabId((current) => {
				if (current !== tabId) return current;
				const next = remaining.find((id) => id !== tabId);
				if (next) void activate(next);
				else setAddress("");
				return next;
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [activate]);

	const emergencyStop = useCallback(async () => {
		const ids = tabsRef.current.map((tab) => tab.id);
		for (const id of ids) {
			await closeNativeTab(id).catch(() => {});
		}
		setTabs([]);
		setActiveTabId(undefined);
		setAddress("");
		setError(undefined);
		await sendCommandAwait({ type: "browser_emergency_stop" }).catch(() => {});
	}, []);

	// Serve agent commands from the sidecar: BROWSER_NATIVE_CMD → execute
	// against the pane → browser_native_result back.
	useEffect(() => {
		let disposed = false;
		let unlistenAgent: (() => void) | undefined;

		void sendCommandAwait({ type: "browser_set_native", enabled: true }).catch(() => {});
		void subscribeBrowserNativeCmd(async (command) => {
			setAgentActive(true);
			try {
				let result: unknown;
				if (command.kind === "navigate") {
					const url = String(command.payload?.url ?? "");
					if (command.payload?.newTab || !activeTabIdRef.current) {
						const id = `t${Date.now() % 100000}_${Math.random().toString(36).slice(2, 6)}`;
						await openNativeTab(id, url);
						setTabs((prev) => [...prev, { id, url, title: "", loading: true }]);
						setActiveTabId(id);
						tabCounter.current = Math.max(tabCounter.current, parseInt(id.slice(1)) || 0);
						result = { url };
					} else {
						await navigateNativeTab(activeTabIdRef.current, url);
						result = { url };
					}
				} else if (command.kind === "activate") {
					await activateNativeTab(String(command.payload?.tabId ?? ""));
					setActiveTabId(String(command.payload?.tabId ?? ""));
					result = { activated: true };
				} else if (command.kind === "close") {
					const tabId = command.payload?.tabId ?? activeTabIdRef.current;
					if (tabId) {
						const remaining = await closeNativeTab(tabId);
						setTabs((prev) => prev.filter((tab) => tab.id !== tabId));
						setActiveTabId((current) => (current === tabId ? remaining.find((id) => id !== tabId) : current));
						result = { closed: [tabId] };
					} else {
						result = { closed: [] };
					}
				} else if (command.kind === "tabs") {
					result = { tabs: tabsRef.current.map((tab) => ({ ...tab, active: tab.id === activeTabIdRef.current })) };
				} else {
					const tabId = activeTabIdRef.current ?? "";
					result = await execBrowserBridge(tabId, String(command.payload?.code ?? "null"));
				}
				await sendCommandAwait({
					type: "browser_native_result",
					nonce: command.nonce,
					ok: true,
					result,
				}).catch(() => {});
			} catch (e) {
				await sendCommandAwait({
					type: "browser_native_result",
					nonce: command.nonce,
					ok: false,
					error: e instanceof Error ? e.message : String(e),
				}).catch(() => {});
			} finally {
				setAgentActive(false);
			}
		}).then((fn) => {
			if (disposed) fn();
			else unlistenAgent = fn;
		});

		return () => {
			disposed = true;
			unlistenAgent?.();
			void sendCommandAwait({ type: "browser_set_native", enabled: false }).catch(() => {});
		};
	}, []);

	// Site permission requests blocked by the host: show an ask bar.
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void listen<{ origin: string; kind: string }>("browser-view-permission", (event) => {
			if (!disposed) setPermissionAsk(event.payload);
		}).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const openPermPanel = useCallback(async () => {
		setPermPanelOpen((open) => !open);
		const list = await invokeNative("browser_view_list_permissions").catch(() => []);
		setPermGrants(Array.isArray(list) ? (list as Array<{ origin: string; kind: string }>) : []);
	}, []);

	const toggleSitePermission = useCallback(async (kind: string, allowed: boolean) => {
		const origin = currentOriginRef.current;
		if (!origin) return;
		await invokeNative("browser_view_allow_permission", { origin, kind, allowed }).catch(() => {});
		setPermGrants((prev) =>
			allowed
				? prev.some((g) => g.origin === origin && g.kind === kind)
					? prev
					: [...prev, { origin, kind }]
				: prev.filter((g) => !(g.origin === origin && g.kind === kind)),
		);
	}, []);

	// --- Web element picker ----------------------------------------------
	const cancelPicking = useCallback(async () => {
		pickRunRef.current += 1;
		setIsPicking(false);
		const tabId = activeTabIdRef.current;
		if (tabId) {
			await execBrowserBridge(tabId, buildCancelWebElementPickerScript(), 3000).catch(() => {});
		}
	}, []);

	const startPicking = useCallback(async () => {
		const tabId = activeTabIdRef.current;
		if (!tabId) return;
		const runId = ++pickRunRef.current;
		setIsPicking(true);
		try {
			const result = (await execBrowserBridge(
				tabId,
				buildWebElementPickerScript({ labels: { color: t("browser.pick.color"), background: t("browser.pick.background"), font: t("browser.pick.font") } }),
				5 * 60_000,
			)) as WebElementPickerScriptResult | null;
			if (pickRunRef.current !== runId) return;
			if (result && result.status === "selected") {
				dispatchWebElementContextAdd(workspace, result.element as WebElementContextPayload);
				// The pick click happened inside the native webview, which owns
				// the macOS keyboard focus — hand it back to the main UI so the
				// composer is actually typable right away.
				await invokeNative("browser_view_focus_main").catch(() => {});
				setPickedNotice(
					t("browser.pick.added", { tag: (result.element as WebElementContextPayload).tagName }),
				);
				setTimeout(() => setPickedNotice(undefined), 6000);
			}
		} catch {
			// navigation away / bridge loss — silently drop out of picking
		} finally {
			if (pickRunRef.current === runId) setIsPicking(false);
		}
	}, [t, workspace]);

	useEffect(() => {
		if (!isPicking) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			void cancelPicking();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [isPicking, cancelPicking]);

	useEffect(() => () => void cancelPicking(), [cancelPicking]);

	const answerPermission = useCallback(async (allowed: boolean) => {
		const ask = permissionAsk;
		setPermissionAsk(undefined);
		if (!ask) return;
		await invokeNative("browser_view_allow_permission", {
			origin: ask.origin,
			kind: ask.kind,
			allowed,
		}).catch(() => {});
	}, [permissionAsk]);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar: tab strip + agent indicator + stop. */}
			<div className="scrollbar-hide flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5">
				{tabs.length === 0 ? (
					<span className="px-1.5 text-xs text-muted/60">{t("browser.noTabs")}</span>
				) : (
					tabs.map((tab) => (
						<span
							key={tab.id}
							className={cn(
								"group flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
								tab.id === activeTabId ? "bg-surface-2 text-accent" : "text-muted hover:bg-surface-2/60",
							)}
						>
							<button onClick={() => void activate(tab.id)} className="max-w-32 truncate" title={tab.url}>
								{tab.loading ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}
								{tab.title || tab.url.replace(/^https?:\/\//, "") || tab.id}
							</button>
							<button
								onClick={() => void closeTab(tab.id)}
								className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100"
								title={t("browser.closeTab")}
							>
								<X className="h-3 w-3" />
							</button>
						</span>
					))
				)}
				<button
					onClick={() => void openTab("about:blank")}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted/70 transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("browser.newTab")}
				>
					<Plus className="h-3.5 w-3.5" />
				</button>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<button
						onClick={() => (isPicking ? void cancelPicking() : void startPicking())}
						disabled={tabs.length === 0}
						className={cn(
							"flex h-7 w-7 items-center justify-center rounded-lg transition-colors disabled:opacity-30",
							isPicking ? "bg-accent/15 text-accent" : "text-muted/70 hover:bg-surface-2 hover:text-fg",
						)}
						title={t("browser.pick.start")}
					>
						<MousePointerClick className="h-3.5 w-3.5" />
					</button>
					{agentActive && (
						<span
							className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
							title={t("browser.agentActiveHint")}
						>
							<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
							{t("browser.agentActive")}
						</span>
					)}
					<button
						onClick={() => void emergencyStop()}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-muted/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
						title={t("browser.stop")}
					>
						<OctagonX className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{/* Navigation + address bar. */}
			{permissionAsk && (
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-500">
					<ShieldAlert className="h-3.5 w-3.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate">
						{t("browser.permissionAsk", { origin: permissionAsk.origin, kind: t(`browser.perm.${permissionAsk.kind}`, permissionAsk.kind) })}
					</span>
					<button
						onClick={() => void answerPermission(true)}
						className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 font-medium text-amber-400 hover:bg-amber-500/30"
					>
						{t("browser.permissionAllow")}
					</button>
					<button
						onClick={() => void answerPermission(false)}
						className="shrink-0 rounded px-2 py-0.5 hover:bg-amber-500/20"
					>
						{t("browser.permissionDeny")}
					</button>
				</div>
			)}
			<form
				className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2"
				onSubmit={(e) => {
					e.preventDefault();
					void navigateActive(address);
				}}
			>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						disabled={navCount < 2}
						onClick={() => activeTabId && void invokeNative("browser_view_go_back", { tabId: activeTabId }).catch(() => {})}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
						title={t("browser.back")}
					>
						<ArrowLeft className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={() => activeTabId && void invokeNative("browser_view_go_forward", { tabId: activeTabId }).catch(() => {})}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("browser.forward")}
					>
						<ArrowRight className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={() => activeTabId && void invokeNative("browser_view_reload", { tabId: activeTabId }).catch(() => {})}
						className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						title={t("browser.reload")}
					>
						<RotateCw className="h-3.5 w-3.5" />
					</button>
				</div>
				<button
					type="button"
					onClick={() => void openPermPanel()}
					className={cn(
						"flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 hover:text-fg",
						siteGrants.length > 0 || permPanelOpen ? "text-emerald-400" : "text-muted",
					)}
					title={t("browser.permissions")}
				>
					{siteGrants.length > 0 ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
				</button>
				<input
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					placeholder={t("browser.addressPlaceholder")}
					spellCheck={false}
					className="h-7 min-w-0 flex-1 rounded-lg bg-surface-2 px-2.5 text-xs text-fg outline-none placeholder:text-muted/50 focus:ring-1 focus:ring-accent/40"
				/>
				<button
					type="submit"
					className="h-7 shrink-0 rounded-lg bg-surface-2 px-2.5 text-xs text-muted transition-colors hover:text-fg"
				>
					{t("browser.go")}
				</button>
				<button
					type="button"
					onClick={() => activeTabId && void invokeNative("browser_view_open_devtools", { tabId: activeTabId }).catch(() => {})}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted transition-colors hover:text-fg"
					title={t("browser.devtools")}
				>
					<Bug className="h-3.5 w-3.5" />
				</button>
			</form>

			{pickedNotice && (
				<div className="shrink-0 border-b border-border bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-400">
					{pickedNotice}
				</div>
			)}

			{/* Site permissions panel — in flow (absolute overlays would render
			    beneath the native webview). */}
			{permPanelOpen && (
				<div className="shrink-0 border-b border-border bg-surface-2/60 px-2.5 py-2 text-[11px]">
					<div className="mb-1.5 flex items-center justify-between">
						<span className="font-medium text-fg">
							{t("browser.permissions")} · {siteOrigin || t("browser.statusIdle")}
						</span>
						<button onClick={() => setPermPanelOpen(false)} className="rounded p-0.5 text-muted hover:text-fg">
							<X className="h-3 w-3" />
						</button>
					</div>
					{PERMISSION_KINDS.map((kind) => {
						const granted = siteGrants.some((g) => g.kind === kind);
						return (
							<div key={kind} className="flex items-center gap-2 py-0.5">
								<span className="min-w-0 flex-1 truncate text-muted">{t(`browser.perm.${kind}`, kind)}</span>
								<button
									onClick={() => void toggleSitePermission(kind, !granted)}
									className={cn(
										"relative h-4 w-7 shrink-0 rounded-full transition-colors",
										granted ? "bg-emerald-500" : "bg-surface-3",
									)}
									title={granted ? t("browser.permissionDeny") : t("browser.permissionAllow")}
								>
									<span
										className={cn(
											"absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
											granted ? "left-3.5" : "left-0.5",
										)}
									/>
								</button>
							</div>
						);
					})}
					<p className="mt-1.5 leading-relaxed text-muted/70">{t("browser.permissionsHint")}</p>
				</div>
			)}

			{/* Native embedded pages (child webviews render over this area). */}
			<div className="relative min-h-0 flex-1">
				<NativeBrowserView onTabPatch={handleTabPatch} />
				{tabs.length === 0 && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface text-center">
						<Globe className="h-5 w-5 text-muted/50" />
						<p className="max-w-52 text-xs leading-relaxed text-muted/80">{t("browser.emptyHint")}</p>
						<code className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">_browser open &lt;url&gt;</code>
					</div>
				)}
				{error && (
					<div className="absolute inset-x-0 top-0 flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
						<span className="min-w-0 flex-1 break-words">{error}</span>
						<button onClick={() => setError(undefined)} className="shrink-0 rounded p-0.5 hover:bg-red-500/20">
							<X className="h-3 w-3" />
						</button>
					</div>
				)}
			</div>

			{/* Status bar. */}
			<div className="flex h-7 shrink-0 items-center justify-between border-t border-border px-2 text-[10px] text-muted/60">
				<span className="truncate">{activeTab ? activeTab.url : t("browser.statusIdle")}</span>
				<span className="shrink-0">
					{t("browser.nativeEngine")}
					{tabs.length > 0 ? ` · ${tabs.length} tab${tabs.length > 1 ? "s" : ""}` : ""}
				</span>
			</div>
		</div>
	);
}
export default function BrowserPane({ workspace }: { workspace?: string | null }) {
	// Remote workspaces use the managed remote Chromium and its forwarded frame
	// server. A local Tauri child webview would render on the wrong machine.
	if (isNativeBrowserAvailable() && !isRemoteWorkspaceKey(workspace)) {
		return <NativeBrowserPane workspace={workspace} />;
	}
	return <MirrorBrowserPane />;
}
