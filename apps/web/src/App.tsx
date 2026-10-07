import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import Layout from "@/components/Layout";
import AgentView from "@/views/AgentView";
import SettingsView from "@/views/SettingsView";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait, listWorkspaces, deleteWorkspace, restartSidecar, stopMainAgent, setRpcWorkspace } from "@/lib/transport";
import { refreshCustomThemes } from "@/lib/theme";
import { BrandIcon } from "@/components/BrandIcon";
import { ConfirmHost } from "@/components/ui";
import { alertDialog } from "@/lib/confirm";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";
import { isTauri, isMainChatCwd, samePath } from "@/lib/utils";

function isMainAgentConflictError(message: string): boolean {
	return message.includes("Another main agent instance is already running");
}

function AppInner() {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(null);
	const [waitingForWorkspace, setWaitingForWorkspace] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [streamingCwds, setStreamingCwds] = useState<Set<string>>(new Set());
	const [recoveringMainAgent, setRecoveringMainAgent] = useState(false);
	const sidecarStartedRef = useRef(false);
	// Last workspace set as the expected rpc response source; used to restore
	// the snapshot when a workspace switch fails mid-flight.
	const lastRpcWorkspaceRef = useRef<string | null>(null);
	// Auto-restart bookkeeping: per-cwd restart count, reset to 0 when a
	// sidecar becomes ready. Capped at 3 attempts with exponential backoff
	// to avoid crash loops.
	const restartCountRef = useRef(0);
	const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monotonic generation for startWithWorkspace runs. When two switches
	// overlap (user click racing an auto-restart), only the NEWEST run may
	// commit its workspace — an older in-flight run finishing later would
	// otherwise overwrite the user's choice (observed as "jumps back to the
	// previous workspace").
	const initGenerationRef = useRef(0);
	// Bumped once per COMPLETED user-visible workspace switch. AgentView keys
	// its history (re)load on this epoch instead of waitingForWorkspace /
	// sidecarReady so silent reconnects never reload the conversation.
	const [switchEpoch, setSwitchEpoch] = useState(0);
	// A workspace whose project directory vanished (deleted repo, cleaned
	// /tmp, …). Switching into it can only fail; instead of the full-screen
	// initError (which hides the sidebar and every recovery path), keep the
	// UI on the current workspace and offer to remove the stale entry.
	const [staleCwd, setStaleCwd] = useState<string | null>(null);
	// Rate limit for silent gateway reconnects (channel drops can arrive in
	// bursts when the desktop re-attaches several workspaces).
	const lastReconnectAtRef = useRef(0);

	const refreshWorkspaces = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const list = await listWorkspaces();
			// Filter out the Chat workspace (~/.pizza/main) — it's shown separately as Chat.
			setWorkspaces(list.filter((ws) => !isMainChatCwd(ws.cwd)));
		} catch (e) {
			console.error("[workspaces] list error:", e);
		}
	}, []);

	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

	const [initError, setInitError] = useState<string | null>(null);
	const startWithWorkspace = useCallback(async (cwd?: string) => {
		const generation = ++initGenerationRef.current;
		// True while this run is still the newest switch. A newer switch
		// (user click, newer restart) must be able to supersede this one —
		// a stale run must not touch UI state after being superseded.
		const isCurrent = () => initGenerationRef.current === generation;
		setWaitingForWorkspace(true);
		setInitError(null);
		// Snapshot the expected response source BEFORE initSidecar: the Rust
		// bridge flips its active-workspace pointer mid-init, so commands issued
		// in between (e.g. AgentView remounting on navigate("/")) can be routed
		// to the previous workspace. sendCommandAwait drops responses whose
		// `_cwd` tag doesn't match this snapshot, so a switch can never render
		// the old workspace's history/state under the new workspace.
		let expandedForRpc = cwd;
		if (cwd && cwd.startsWith("~") && isTauri()) {
			try {
				const { homeDir } = await import("@tauri-apps/api/path");
				const home = await homeDir();
				expandedForRpc = cwd.replace("~", home);
			} catch { /* keep ~ */ }
		}
		const previousRpcWorkspace = lastRpcWorkspaceRef.current;
		lastRpcWorkspaceRef.current = expandedForRpc ?? null;
		setRpcWorkspace(lastRpcWorkspaceRef.current);
		// Clear stale state from the previous workspace so the UI doesn't
		// briefly render the old workspace's session/streaming/model info
		// while the new sidecar's get_state response is in-flight (gateway
		// mode returns empty state for already-running workspaces).
		setState(null);
		try {
			const initialState = await initSidecar(cwd);
			if (!isCurrent()) return; // superseded by a newer switch
			// Expand ~ to home directory so workspace state matches Rust side.
			let expandedCwd = cwd;
			if (cwd && cwd.startsWith("~") && isTauri()) {
				try {
					const { homeDir } = await import("@tauri-apps/api/path");
					const home = await homeDir();
					expandedCwd = cwd.replace("~", home);
				} catch { /* keep ~ */ }
			}
			if (expandedCwd) setWorkspace(expandedCwd);
			// If we got a non-empty state, it's a freshly spawned sidecar.
			// If empty, the sidecar was already running — state will arrive via rpc_response event.
			const hasState = initialState && Object.keys(initialState).length > 0;
			if (hasState) {
				setState(initialState as unknown as RpcSessionState);
			}
			setSidecarReady(true);
			void refreshCustomThemes().catch(() => {});
			// For already-running sidecar, request state explicitly.
			if (!hasState) {
				void sendCommandAwait<RpcSessionState>({ type: "get_state" })
					.then((r) => setState(r.data ?? null))
					.catch(() => {});
			}
			refreshWorkspaces();
			// Completed a user-visible switch → let AgentView (re)load history.
			setSwitchEpoch((e) => e + 1);
		} catch (e) {
			if (!isCurrent()) return; // superseded — leave state to the newer run
			// initSidecar failed — the bridge is still routing to the previous
			// workspace, so restore its snapshot as the expected response source.
			lastRpcWorkspaceRef.current = previousRpcWorkspace;
			setRpcWorkspace(previousRpcWorkspace);
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[init] FAILED:", msg);
			if (msg.includes("does not exist")) {
				// Missing project directory: NOT a fatal init error — the
				// previous workspace is still healthy. Offer removing the
				// stale entry and stay where we are.
				setInitError(null);
				setStaleCwd(expandedForRpc ?? cwd ?? null);
				refreshWorkspaces();
			} else {
				setInitError(msg);
			}
		} finally {
			if (isCurrent()) setWaitingForWorkspace(false);
		}
	}, [refreshWorkspaces]);

	/**
	 * Silently re-attach the current workspace after a gateway channel drop.
	 * The pooled agent is still alive server-side — only the channel died —
	 * so this must NOT flip sidecarReady / waitingForWorkspace / switchEpoch:
	 * doing so unmounts the conversation and reloads history, which the user
	 * sees as the app "flickering" and the session "re-initializing". Falls
	 * back to a full restart (with error surface) when re-attaching fails.
	 */
	const reconnectWorkspace = useCallback(async (cwd: string) => {
		lastReconnectAtRef.current = Date.now();
		try {
			const stateFrame = await initSidecar(cwd);
			if (stateFrame && Object.keys(stateFrame).length > 0) {
				setState(stateFrame as unknown as RpcSessionState);
			} else {
				void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
					.then((r) => setState(r.data ?? null))
					.catch(() => {});
			}
			// Channel is healthy again — allow future silent reconnects.
			restartCountRef.current = 0;
		} catch (e) {
			console.warn("[sidecar] silent reconnect failed, falling back to full restart:", e);
			restartCountRef.current += 1;
			setSidecarReady(false);
			if (restartCountRef.current <= 3) {
				const delay = Math.min(1000 * Math.pow(2, restartCountRef.current - 1), 4000);
				if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
				restartTimerRef.current = setTimeout(() => {
					restartTimerRef.current = null;
					setWorkspace((current) => {
						if (samePath(current, cwd)) void startWithWorkspace(cwd);
						return current;
					});
				}, delay);
			}
		}
	}, [startWithWorkspace]);

	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		if (isTauri()) {
			// In Tauri: auto-start with Chat (persistent agent at ~/.pizza/main)
			startWithWorkspace("~/.pizza/main");
		} else {
			// Browser: auto-init with dev bridge
			startWithWorkspace();
		}
	}, [startWithWorkspace]);

	const handleNewWorkspace = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const dialog = await import("@tauri-apps/plugin-dialog");
			const selected = await dialog.open({ directory: true, multiple: false, title: t("layout.selectProjectDirectory") });
			if (typeof selected === "string") {
				// Spawning a brand-new sidecar takes seconds — show the
				// full-screen waiting state (clears the old workspace's UI).
				// Plain switches between running workspaces keep the UI
				// mounted so AgentView's per-workspace caches survive.
				setSidecarReady(false);
				await startWithWorkspace(selected);
			}
		} catch (e) {
			console.error("[workspace] dialog error:", e);
		}
	}, [startWithWorkspace, t]);

	const handleSelectWorkspace = useCallback(async (cwd: string) => {
		if (samePath(workspace, cwd) && sidecarReady) return;
		// Navigate back to agent page when selecting a workspace.
		navigate("/");
		// startWithWorkspace sets workspace AFTER initSidecar completes,
		// so get_messages goes to the correct sidecar.
		await startWithWorkspace(cwd);
	}, [workspace, sidecarReady, startWithWorkspace, navigate]);

	const handleDeleteWorkspace = useCallback((workspaceId: string) => {
		setWorkspaces((prev) => prev.filter((ws) => ws.workspace_id !== workspaceId));
	}, []);

	const handleRecoverMainAgent = useCallback(async () => {
		setRecoveringMainAgent(true);
		try {
			await stopMainAgent();
			setInitError(null);
			await startWithWorkspace("~/.pizza/main");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setInitError(msg);
		} finally {
			setRecoveringMainAgent(false);
		}
	}, [startWithWorkspace]);

	// Refresh the session state from the sidecar. Used after settings that
	// don't emit a dedicated event (e.g. toggling safe mode) so the root
	// state stays in sync for components that read from it.
	const refreshState = useCallback(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
	}, [sidecarReady]);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeSidecarExit((code, cwd) => {
				// Only act if the exited sidecar was the active one.
				if (!cwd || samePath(cwd, workspace)) {
					if (code === null) {
						// Gateway channel drop (bridge emits code:null) — the
						// agent process is still alive in the gateway pool.
						// Re-attach silently; no UI reset, no history reload.
						// Rate-limited: drops can arrive in bursts.
						const since = Date.now() - lastReconnectAtRef.current;
						const delay = since < 2000 ? 2000 - since : 0;
						if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
						restartTimerRef.current = setTimeout(() => {
							restartTimerRef.current = null;
							setWorkspace((current) => {
								if (samePath(current, cwd ?? workspace)) void reconnectWorkspace(current!);
								return current;
							});
						}, delay);
						return;
					}
					setSidecarExitCode(code);
					setSidecarReady(false);
					// Auto-restart with exponential backoff (max 3 attempts).
					// The count is reset to 0 whenever a sidecar becomes ready,
					// so a fresh crash after a healthy run still gets 3 retries.
					const cwdToRestart = workspace;
					if (cwdToRestart && restartCountRef.current < 3) {
						restartCountRef.current += 1;
						const attempt = restartCountRef.current;
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
						console.warn(`[sidecar] exited (code=${code}), auto-restart attempt ${attempt}/3 in ${delay}ms`);
						if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
						restartTimerRef.current = setTimeout(() => {
							restartTimerRef.current = null;
							// Guard against the user having switched workspaces in the meantime.
							setWorkspace((current) => {
								if (samePath(current, cwdToRestart)) {
									void startWithWorkspace(cwdToRestart);
								}
								return current;
							});
						}, delay);
					} else if (cwdToRestart) {
						console.warn(`[sidecar] exited, giving up auto-restart after 3 attempts`);
					}
				}
			});
			if (cancelled) { un1(); return; }
			unlisteners.push(un1);
			const un2 = await subscribeEvents((event) => {
				const typed = event as { type: string; _cwd?: string };
				// Track per-workspace streaming state for ALL workspaces
				// so the sidebar can show blinking indicators even for
				// non-active workspaces.
				if (typed._cwd && (typed.type === "AGENT_TURN_START" || typed.type === "AGENT_TURN_COMPLETED")) {
					setStreamingCwds((prev) => {
						const next = new Set(prev);
						if (typed.type === "AGENT_TURN_START") {
							next.add(typed._cwd!);
						} else {
							next.delete(typed._cwd!);
						}
						return next;
					});
				}
				// Only process state updates for the active workspace.
				if (typed._cwd && !samePath(typed._cwd, workspace)) return;
				// Refresh state on model/thinking changes, and when the agent
				// turn starts (isStreaming → true) or completes (isStreaming → false).
				// Skip intermediate AGENT_TURN_END/REQUESTED during multi-tool turns
				// to avoid flooding get_state requests that time out.
				if (
					typed.type === "MODEL_CHANGED" ||
					typed.type === "THINKING_LEVEL_CHANGED" ||
					typed.type === "AGENT_TURN_COMPLETED" ||
					typed.type === "AGENT_TURN_START" ||
					typed.type === "SESSION_CREATED" ||
					typed.type === "SESSION_FORKED" ||
					typed.type === "SESSION_JUMPED"
				) {
					void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
						.then((r) => setState(r.data ?? null))
						.catch(() => {});
				}
			});
			if (cancelled) { un2(); return; }
			unlisteners.push(un2);
		})();
		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, [sidecarReady, workspace, startWithWorkspace, reconnectWorkspace]);

	// Reset the auto-restart counter once a sidecar is healthy, and clean up
	// any pending restart timer on unmount.
	useEffect(() => {
		if (sidecarReady) {
			restartCountRef.current = 0;
		}
	}, [sidecarReady]);

	useEffect(() => {
		return () => {
			if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
		};
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" })
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
		// Delayed re-fetch: the sidecar may emit MODEL_CHANGED before our
		// event listener is registered, leaving state.model stale. This
		// catches any missed events shortly after sidecar ready / workspace switch.
		const timer = setTimeout(() => {
			void sendCommandAwait<RpcSessionState>({ type: "get_state" })
				.then((r) => setState(r.data ?? null))
				.catch(() => {});
		}, 800);
		return () => clearTimeout(timer);
	}, [sidecarReady, workspace]);

	// First-run / unconfigured-key detection: when the sidecar comes up but
	// `state.model` is undefined, no provider has an API key configured yet.
	// Redirect the user into a setup-mode Settings page instead of dumping
	// them into an empty agent they can't actually use.
	useEffect(() => {
		if (!sidecarReady) return;
		if (!state) return;
		if (state.model !== undefined) return;
		// Only redirect once per workspace, and only if the user isn't
		// already on the setup settings page (avoid stealing the back button).
		// Read the path off `window` rather than `useLocation` on purpose: we
		// deliberately do NOT want this effect re-running on every navigation,
		// otherwise an unconfigured user gets yanked back here the moment they
		// try to visit the plugins page or anywhere else.
		if (!window.location.pathname.startsWith("/settings")) {
			navigate("/settings?setup=true", { replace: true });
		}
	}, [sidecarReady, state, navigate]);

	// After the user configures a key, the sidecar is restarted and a new
	// state arrives with `state.model !== undefined`. Pull them back out of
	// the setup-mode Settings page automatically. Doing it here (rather
	// than inside SettingsView.handleConfigured) avoids a race where the
	// local `setState` hasn't propagated before navigate fires, which
	// would let the redirect-above re-trigger and bounce them back.
	useEffect(() => {
		if (!state || state.model === undefined) return;
		if (!location.pathname.startsWith("/settings")) return;
		if (new URLSearchParams(location.search).get("setup") !== "true") return;
		navigate("/", { replace: true });
	}, [state, navigate, location.pathname, location.search]);

	// Stale-workspace dialog: directory missing → offer removal, keep UI.
	if (staleCwd) {
		const staleWs = workspaces.find((ws) => samePath(ws.cwd, staleCwd));
		const removeStale = async () => {
			if (staleWs) {
				try {
					await deleteWorkspace(staleWs.workspace_id);
				} catch (err) {
					console.error("[workspace] delete stale error:", err);
					void alertDialog({ title: t("common.error"), message: err instanceof Error ? err.message : String(err), danger: true });
				}
			}
			setStaleCwd(null);
			refreshWorkspaces();
		};
		const p = (
			<PxlKitSurfaceProvider surface="linear">
				<ConfirmHost />
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex max-w-lg flex-col items-center gap-4 px-6 text-center">
						<BrandIcon size={48} className="text-warning" />
						<p className="text-sm text-fg">{t("agent.staleWorkspaceTitle")}</p>
						<p className="max-w-md break-all text-sm leading-6 text-muted">{staleCwd}</p>
						<p className="text-xs text-muted">{t("agent.staleWorkspaceBody")}</p>
						<div className="mt-2 flex flex-wrap justify-center gap-3">
							<button
								type="button"
								onClick={() => void removeStale()}
								className="rounded-md border border-danger bg-danger/15 px-4 py-2 text-sm text-danger transition-colors hover:bg-danger/25"
							>
								{t("agent.staleWorkspaceRemove")}
							</button>
							<button
								type="button"
								onClick={() => setStaleCwd(null)}
								className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80"
							>
								{t("common.cancel")}
							</button>
						</div>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
		return p;
	}

	if (initError) {
		const mainAgentConflict = isMainAgentConflictError(initError);
		return (
			<PxlKitSurfaceProvider surface="linear">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex max-w-lg flex-col items-center gap-4 px-6 text-center">
						<BrandIcon size={48} className="text-danger" />
						<p className="text-sm text-fg">
							{mainAgentConflict ? t("agent.mainConflictTitle") : t("agent.failedToStartWorkspace")}
						</p>
						{mainAgentConflict ? (
							<>
								<p className="max-w-md text-sm leading-6 text-muted">{t("agent.mainConflictBody")}</p>
								<details className="w-full text-left">
									<summary className="cursor-pointer text-xs text-muted">{t("agent.errorDetails")}</summary>
									<pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
										{initError}
									</pre>
								</details>
								<div className="mt-2 flex flex-wrap justify-center gap-3">
									<button
										type="button"
										disabled={recoveringMainAgent}
										onClick={handleRecoverMainAgent}
										className="rounded-md border border-accent bg-accent/15 px-4 py-2 text-sm text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
									>
										{recoveringMainAgent ? t("agent.restartingMainAgent") : t("agent.stopOldAndRestart")}
									</button>
									<button
										type="button"
										disabled={recoveringMainAgent}
										onClick={() => {
											setInitError(null);
											startWithWorkspace("~/.pizza/main");
										}}
										className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80 disabled:cursor-not-allowed disabled:opacity-60"
									>
										{t("agent.retryStart")}
									</button>
								</div>
							</>
						) : (
							<>
								<p className="text-xs text-muted">{initError}</p>
								<button
									type="button"
									onClick={() => {
										setInitError(null);
										startWithWorkspace("~/.pizza/main");
									}}
									className="mt-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80"
								>
									{t("common.backToAgent")}
								</button>
							</>
						)}
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	// Keep the app mounted while switching between running workspaces:
	// AgentView holds per-workspace conversation caches (itemsByWs etc.) in
	// refs — unmounting here would wipe them and lose the streaming/spinner
	// state of an in-flight turn, so the waiting screen only shows when there
	// is no live sidecar to show (first start / crashed sidecar).
	if (waitingForWorkspace && !sidecarReady) {
		return (
			<PxlKitSurfaceProvider surface="linear">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex flex-col items-center gap-4">
						<BrandIcon size={48} className="text-accent" />
						<p className="text-sm text-muted">{t("common.starting")}</p>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	return (
		<PxlKitSurfaceProvider surface="linear">
			<ConfirmHost />
			<Routes>
					<Route
						element={
							<Layout
								state={state}
								sidecarReady={sidecarReady}
								sidecarExitCode={sidecarExitCode}
								workspace={workspace}
								workspaces={workspaces}
								streamingCwds={streamingCwds}
								onSelectWorkspace={handleSelectWorkspace}
								onNewWorkspace={handleNewWorkspace}
							onDeleteWorkspace={handleDeleteWorkspace}
							/>
						}
					>
						<Route
							index
							element={
								<AgentView
									state={state}
									sidecarReady={sidecarReady}
									sidecarExitCode={sidecarExitCode}
				workspace={workspace}
				workspaces={workspaces}
				waitingForWorkspace={waitingForWorkspace}
				switchEpoch={switchEpoch}
				onRefreshState={refreshState}
								/>
							}
						/>
						<Route path="/settings" element={
							<SettingsView
								state={state}
								onRestartSidecar={async () => {
									if (!workspace) return;
									// restart_sidecar (Rust) returns the entire JSON-RPC
									// response envelope `{id, type, command, success,
									// data: {...}}` from the new sidecar's first
									// get_state. Unwrap the `.data` payload before
									// feeding it into `state`, otherwise state.model
									// stays undefined and the navigate-back useEffect
									// below never fires.
									const newStateJson = await restartSidecar(workspace);
									try {
										const parsed = JSON.parse(newStateJson);
										const data = parsed?.data ?? parsed;
										if (data && typeof data === "object" && Object.keys(data).length > 0) {
											setState(data as unknown as RpcSessionState);
										}
									} catch {
										// Best-effort: if parsing fails, the sidecar's
										// own MODEL_CHANGED event will still propagate a
										// fresh state via subscribeEvents → get_state.
									}
								}}
							/>
						} />
					<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
			</Routes>
		</PxlKitSurfaceProvider>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppInner />
		</BrowserRouter>
	);
}
