/**
 * BrowserController — the managed-browser engine.
 *
 * One instance per Pizza process (sidecar / TUI / print). It owns:
 *  - a lazily-launched shared Chromium (playwright-core, external executable)
 *  - a single non-persistent BrowserContext (in-memory cookies/storage — no
 *    credential residue on disk by default; persistent profiles are a
 *    deliberate non-goal of v1)
 *  - the tab registry, navigation policy, snapshot/ref cache, screencast
 *    frame session, and download handling
 *
 * Audit events flow through BrowserHostHooks.emitAuditEvent with whitelisted
 * payloads only (see types.ts). The frame channel is exposed through
 * attachFrameSink for the FrameServer.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../../config.js";
import { resolveChromium } from "./chromium.js";
import { NavigationPolicy, normalizeUrl } from "./policy.js";
import type {
	BrowserHostHooks,
	BrowserInputEvent,
	BrowserTabInfo,
	FrameServerMessage,
	ResolvedChromium,
} from "./types.js";

/** Error carrying a stable machine-readable code for the tool surface. */
export class BrowserError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "BrowserError";
	}
}

interface ManagedTab {
	id: string;
	url: string;
	title: string;
	openedAt: number;
	lastActiveAt: number;
	/** Bumped on every main-frame navigation; invalidates cached snapshots. */
	epoch: number;
	snapshot?: string;
}

export interface PushedFrame {
	tabId: string;
	frameId: number;
	width: number;
	height: number;
	data: Buffer;
}

export type FrameSink = (frame: PushedFrame) => void;
export type ControlListener = (message: FrameServerMessage) => void;

export interface ControllerState {
	available: boolean;
	chromium?: { executablePath: string; source: string; version?: string };
	tabs: BrowserTabInfo[];
	activeTabId?: string;
	panelVisible: boolean;
	agentActive: boolean;
	downloads: Array<{ filename: string; path: string; size: number; at: number; tabId?: string }>;
}

const MAX_TABS = 8;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT_MS = 8000;
const SCREAMCAST_QUALITY = 70;

function sanitizeFilename(name: string): string {
	const base = path.basename(name ?? "download");
	const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").replace(/^\.+/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 200) : "download";
}

export class BrowserController {
	private chromiumResolution?: Promise<ResolvedChromium | undefined>;
	private browser: import("playwright-core").Browser | undefined;
	private context: import("playwright-core").BrowserContext | undefined;
	private readonly tabs = new Map<string, ManagedTab>();
	private tabCounter = 0;
	private activeTabId: string | undefined;
	private readonly policy = new NavigationPolicy();
	private hooks: BrowserHostHooks = {};
	private panelVisible = false;
	private agentActive = false;
	private screencastDisposable: { dispose(): Promise<void> } | undefined;
	private frameCounter = 0;
	private readonly frameSinks = new Set<FrameSink>();
	private readonly controlListeners = new Set<ControlListener>();
	private readonly downloads: ControllerState["downloads"] = [];
	private launching?: Promise<void>;

	// ------------------------------------------------------------------
	// Singleton
	// ------------------------------------------------------------------

	private static singleton: BrowserController | undefined;

	static getInstance(): BrowserController {
		BrowserController.singleton ??= new BrowserController();
		return BrowserController.singleton;
	}

	/** Test escape hatch. */
	static resetInstance(): void {
		void BrowserController.singleton?.emergencyStop().catch(() => {});
		BrowserController.singleton = undefined;
	}

	setHostHooks(hooks: BrowserHostHooks): void {
		this.hooks = hooks;
		if (hooks.resolveApproval) {
			this.policy.setApprovalMode("on");
		}
	}

	setApprovalMode(mode: "auto" | "on" | "off"): void {
		this.policy.setApprovalMode(mode);
	}

	// ------------------------------------------------------------------
	// Launch / teardown
	// ------------------------------------------------------------------

	private async resolveChromiumOnce(): Promise<ResolvedChromium | undefined> {
		this.chromiumResolution ??= resolveChromium();
		return this.chromiumResolution;
	}

	/** Resolve the playwright module lazily so sessions that never touch the browser pay nothing. */
	private async loadPlaywright(): Promise<typeof import("playwright-core")> {
		try {
			return await import("playwright-core");
		} catch (error) {
			throw new BrowserError(
				"playwright_missing",
				`playwright-core could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async ensureBrowser(): Promise<import("playwright-core").BrowserContext> {
		if (this.context) return this.context;
		this.launching ??= (async () => {
			const pw = await this.loadPlaywright();
			const chromium = await this.resolveChromiumOnce();
			if (!chromium) {
				throw new BrowserError(
					"chromium_not_found",
					"No managed Chromium found. Set PIZZA_BROWSER_EXECUTABLE, run /browser install (downloads Chrome for Testing), or install Google Chrome.",
				);
			}
			const headful = process.env["PIZZA_BROWSER_HEADFUL"] === "1";
			const browser = await pw.chromium.launch({
				executablePath: chromium.executablePath,
				headless: !headful,
			});
			const context = await browser.newContext({
				viewport: DEFAULT_VIEWPORT,
				deviceScaleFactor: 1,
				// Chrome-shaped UA (mirror engine parity with the native pane and
				// ZCode's Chromium IAB): a bare "HeadlessChrome/x" UA is an instant
				// bot signal to risk engines like Baidu's.
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			});
			context.setDefaultTimeout(ACTION_TIMEOUT_MS);
			browser.on("disconnected", () => {
				this.browser = undefined;
				this.context = undefined;
				// Allow a fresh launch after a crash (see emergencyStop).
				this.launching = undefined;
				this.tabs.clear();
				this.activeTabId = undefined;
				this.stopScreencast();
				this.emitControl({ type: "tabs", tabs: [] });
			});
			this.browser = browser;
			this.context = context;
		})();
		try {
			await this.launching;
		} catch (error) {
			this.launching = undefined;
			throw error;
		}
		if (!this.context) throw new BrowserError("launch_failed", "browser context unavailable after launch");
		return this.context;
	}

	// ------------------------------------------------------------------
	// State
	// ------------------------------------------------------------------

	getState(): ControllerState {
		const chromium = this.cachedChromium;
		return {
			available: Boolean(this.context),
			chromium: chromium
				? { executablePath: chromium.executablePath, source: chromium.source, version: chromium.version }
				: undefined,
			tabs: this.listTabs(),
			activeTabId: this.activeTabId,
			panelVisible: this.panelVisible,
			agentActive: this.agentActive,
			downloads: [...this.downloads],
		};
	}

	private cachedChromium: ResolvedChromium | undefined;

	/** Resolve (and cache) the managed-Chromium location for status output. */
	async resolveChromiumInfo(): Promise<ResolvedChromium | undefined> {
		this.cachedChromium ??= await this.resolveChromiumOnce();
		return this.cachedChromium;
	}

	listTabs(): BrowserTabInfo[] {
		return [...this.tabs.values()]
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt)
			.map((tab) => this.tabInfo(tab));
	}

	private tabInfo(tab: ManagedTab): BrowserTabInfo {
		const origin = (() => {
			try {
				return new URL(tab.url).origin;
			} catch {
				return "";
			}
		})();
		return {
			id: tab.id,
			url: tab.url,
			title: tab.title,
			origin,
			active: tab.id === this.activeTabId,
			openedAt: tab.openedAt,
			lastActiveAt: tab.lastActiveAt,
		};
	}

	private get activeTab(): ManagedTab | undefined {
		return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
	}

	private requireActivePage(): { tab: ManagedTab; page: import("playwright-core").Page } {
		const tab = this.activeTab;
		if (!tab) throw new BrowserError("no_active_tab", "No active browser tab — run _browser open <url> first");
		const page = this.context?.pages().find((p) => (p as unknown as { __pizzaTabId?: string }).__pizzaTabId === tab.id);
		if (!page) throw new BrowserError("tab_gone", `Tab ${tab.id} no longer exists`);
		return { tab, page };
	}

	private audit(type: string, payload: Record<string, unknown>): void {
		try {
			this.hooks.emitAuditEvent?.(type, payload);
		} catch {
			// Audit failures must never break the action they describe.
		}
	}

	private emitControl(message: FrameServerMessage): void {
		for (const listener of this.controlListeners) {
			try {
				listener(message);
			} catch {
				// Listener errors must not break the engine.
			}
		}
	}

	// ------------------------------------------------------------------
	// Tab lifecycle
	// ------------------------------------------------------------------

	private async newTab(url: URL): Promise<ManagedTab> {
		const context = await this.ensureBrowser();
		if (this.tabs.size >= MAX_TABS) {
			// Evict the least recently active non-active tab.
			const victim = [...this.tabs.values()]
				.filter((t) => t.id !== this.activeTabId)
				.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
			if (victim) await this.closeTabById(victim.id, "residency");
			else throw new BrowserError("tab_limit", `Tab limit reached (${MAX_TABS})`);
		}
		const page = await context.newPage();
		const id = `t${++this.tabCounter}`;
		(page as unknown as { __pizzaTabId?: string }).__pizzaTabId = id;
		const tab: ManagedTab = {
			id,
			url: url.toString(),
			title: "",
			openedAt: Date.now(),
			lastActiveAt: Date.now(),
			epoch: 0,
		};
		this.tabs.set(id, tab);
		this.wirePage(page, tab);

		// domcontentloaded (not the default "load"): heavy pages keep pulling
		// ads/trackers long after the DOM is interactive, and waiting for the
		// full load event used to blow the frontend's RPC timeout even though
		// the page was already usable.
		await page.goto(url.toString(), { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
			throw new BrowserError(
				"navigation_failed",
				`Navigation to ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		await this.syncTabFromPage(page, tab);
		// Restart the screencast when a panel is watching: the first tab just
		// became active, so without this the mirror stays dark until the next
		// activation. (restartScreencast no-ops when the panel is hidden.)
		this.setActiveTabId(id, true);
		this.audit("BROWSER_TAB_OPENED", { tab_id: id, origin: url.origin });
		this.emitControl({ type: "tabs", tabs: this.listTabs() });
		return tab;
	}

	private wirePage(page: import("playwright-core").Page, tab: ManagedTab): void {
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			tab.epoch += 1;
			tab.snapshot = undefined;
			void this.syncTabFromPage(page, tab);
			const decision = this.policy.classify(frame.url());
			if (decision.decision === "block") {
				this.audit("BROWSER_ACTION", {
					action: "navigation_blocked",
					tab_id: tab.id,
					origin: decision.origin,
					outcome: decision.reason ?? "blocked",
				});
				// Undo in-flight navigation we did not approve. Load a blank
				// page rather than goBack(): history may be empty (first nav).
				void page.goto("about:blank").catch(() => {});
				return;
			}
			this.audit("BROWSER_NAVIGATED", { tab_id: tab.id, origin: decision.origin });
			this.emitControl({
				type: "navigated",
				tabId: tab.id,
				url: frame.url(),
				title: tab.title,
			});
		});
		page.on("dialog", (dialog) => {
			// Registering this listener disables Playwright's implicit auto-
			// dismiss; we must dismiss explicitly or every action after a
			// dialog hangs.
			void dialog.dismiss().catch(() => {});
			this.audit("BROWSER_ACTION", {
				action: "dialog_dismissed",
				tab_id: tab.id,
				dialog_type: dialog.type(),
				outcome: "dismissed",
			});
		});
		page.on("download", (download) => {
			void this.handleDownload(download, tab).catch(() => {});
		});
		page.on("close", () => {
			if (this.tabs.delete(tab.id)) {
				if (this.activeTabId === tab.id) {
					const next = [...this.tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
					this.setActiveTabId(next?.id, true);
				}
				this.audit("BROWSER_TAB_CLOSED", { tab_id: tab.id });
				this.emitControl({ type: "tab_closed", tabId: tab.id });
				this.emitControl({ type: "tabs", tabs: this.listTabs() });
			}
		});
	}

	private async syncTabFromPage(page: import("playwright-core").Page, tab: ManagedTab): Promise<void> {
		try {
			tab.url = page.url();
			tab.title = (await page.title()) || tab.title;
		} catch {
			// Page may be mid-teardown.
		}
	}

	private setActiveTabId(id: string | undefined, restartScreencast: boolean): void {
		this.activeTabId = id;
		const tab = id ? this.tabs.get(id) : undefined;
		if (tab) tab.lastActiveAt = Date.now();
		if (id) {
			this.emitControl({ type: "tab_activated", tabId: id });
		}
		if (restartScreencast && this.panelVisible) {
			void this.restartScreencast();
		}
	}

	// ------------------------------------------------------------------
	// Public actions (agent tool surface + RPC surface)
	// ------------------------------------------------------------------

	/** Open a URL. Reuses an existing same-origin tab unless newTab. */
	async open(rawUrl: string, options: { newTab?: boolean; source?: string } = {}): Promise<BrowserTabInfo> {
		const url = normalizeUrl(rawUrl);
		if (!url) throw new BrowserError("invalid_url", `Cannot parse URL: ${rawUrl}`);
		const decision = await this.policy.check(url.toString(), options.source ?? "agent");
		if (decision.decision === "block") {
			this.audit("BROWSER_ACTION", {
				action: "open",
				origin: url.origin,
				outcome: "blocked",
				reason: decision.reason,
			});
			throw new BrowserError("navigation_blocked", `Navigation to ${url.origin} blocked by policy (${decision.reason})`);
		}
		this.audit("BROWSER_ACTION", {
			action: "open",
			origin: url.origin,
			outcome: decision.decision === "allow" ? "allowed" : decision.reason ?? "allowed",
			reason: decision.reason,
		});

		if (!options.newTab) {
			const existing = [...this.tabs.values()].find((tab) => {
				try {
					return new URL(tab.url).origin === url.origin;
				} catch {
					return false;
				}
			});
			if (existing) {
				await this.navigate(existing.id, url.toString(), "agent-reuse");
				return this.tabInfo(this.tabs.get(existing.id) ?? existing);
			}
		}
		const tab = await this.newTab(url);
		return this.tabInfo(tab);
	}

	/** Navigate an existing tab (agent or user-driven address bar). */
	async navigate(tabId: string | undefined, rawUrl: string, source = "user"): Promise<BrowserTabInfo> {
		const url = normalizeUrl(rawUrl);
		if (!url) throw new BrowserError("invalid_url", `Cannot parse URL: ${rawUrl}`);
		const decision = await this.policy.check(url.toString(), source);
		if (decision.decision === "block") {
			throw new BrowserError("navigation_blocked", `Navigation to ${url.origin} blocked by policy (${decision.reason})`);
		}
		const target = tabId ?? this.activeTabId;
		const tab = target ? this.tabs.get(target) : undefined;
		if (!tab) throw new BrowserError("no_active_tab", "No tab to navigate");
		const page = this.context?.pages().find((p) => (p as unknown as { __pizzaTabId?: string }).__pizzaTabId === tab.id);
		if (!page) throw new BrowserError("tab_gone", `Tab ${tab.id} no longer exists`);
		await page.goto(url.toString(), { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
			throw new BrowserError(
				"navigation_failed",
				`Navigation to ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		await this.syncTabFromPage(page, tab);
		// Push a tabs refresh so connected panels re-render titles/urls even
		// when the navigation didn't come from them.
		this.emitControl({ type: "tabs", tabs: this.listTabs() });
		return this.tabInfo(tab);
	}

	/**
	 * ARIA snapshot with AI refs (`[ref=e2]`). Cached per tab epoch — refs
	 * resolve against the latest snapshot in the element's frame, so callers
	 * must re-snapshot after any page change.
	 */
	async snapshot(): Promise<string> {
		const { tab, page } = this.requireActivePage();
		if (tab.snapshot !== undefined) return tab.snapshot;
		const text = await page.ariaSnapshot({ mode: "ai" }).catch((error: unknown) => {
			throw new BrowserError(
				"snapshot_failed",
				`ARIA snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		tab.snapshot = text;
		return text;
	}

	/**
	 * Fast-fail ref actions against the cached snapshot: a ref absent from
	 * the snapshot can never resolve, and waiting for Playwright's locator
	 * timeout would burn 8s and misreport as action_timeout instead of the
	 * actionable "re-snapshot" guidance.
	 */
	private assertRefKnown(tab: ManagedTab, ref: string): void {
		const snapshot = tab.snapshot;
		if (snapshot && !snapshot.includes(`[ref=${ref}]`)) {
			throw new BrowserError(
				"stale_ref",
				`ref ${ref} is not in the current snapshot — re-run _browser snapshot after the page changed`,
			);
		}
	}

	/** Click by ref (preferred) or by coordinates validated against a frame epoch. */
	async click(input: { ref?: string; x?: number; y?: number; frameId?: number }): Promise<void> {
		const { tab, page } = this.requireActivePage();
		if (input.ref) {
			const ref = normalizeRef(input.ref);
			await this.ensureSnapshot(page);
			this.assertRefKnown(tab, ref);
			const locator = page.getByRef(ref);
			await locator.click().catch((error: unknown) => {
				throw translateActionError("click", error);
			});
			this.invalidateSnapshot();
			return;
		}
		this.validateCoordinates(input);
		await page.mouse.click(input.x!, input.y!).catch((error: unknown) => {
			throw translateActionError("click", error);
		});
		this.invalidateSnapshot();
	}

	/** Type text into a ref-targeted input, or at the current caret. */
	async type(input: { ref?: string; text: string; x?: number; y?: number; frameId?: number }): Promise<void> {
		const { tab, page } = this.requireActivePage();
		if (input.ref) {
			const ref = normalizeRef(input.ref);
			await this.ensureSnapshot(page);
			this.assertRefKnown(tab, ref);
			await page.getByRef(ref).fill(input.text).catch(async (fillError: unknown) => {
				// fill() only works on editable elements; fall back to click+type
				// for contenteditable-ish targets.
				try {
					const locator = page.getByRef(ref);
					await locator.click();
					await page.keyboard.type(input.text);
				} catch {
					throw translateActionError("type", fillError);
				}
			});
			this.invalidateSnapshot();
			return;
		}
		this.validateCoordinates(input);
		await page.mouse.click(input.x!, input.y!);
		await page.keyboard.type(input.text);
		this.invalidateSnapshot();
	}

	/** Press a key (Playwright key name: "Enter", "Tab", "a", …). */
	async key(key: string): Promise<void> {
		const { page } = this.requireActivePage();
		await page.keyboard.press(key).catch((error: unknown) => {
			throw translateActionError("key", error);
		});
		this.invalidateSnapshot();
	}

	async scroll(input: { ref?: string; direction?: "up" | "down"; amount?: number }): Promise<void> {
		const { tab, page } = this.requireActivePage();
		const amount = Math.max(1, Math.min(5000, input.amount ?? 600));
		if (input.ref) {
			const ref = normalizeRef(input.ref);
			await this.ensureSnapshot(page);
			this.assertRefKnown(tab, ref);
			await page.getByRef(ref).scrollIntoViewIfNeeded().catch((error: unknown) => {
				throw translateActionError("scroll", error);
			});
			return;
		}
		const delta = input.direction === "up" ? -amount : amount;
		await page.mouse.wheel(0, delta).catch((error: unknown) => {
			throw translateActionError("scroll", error);
		});
	}

	/** Static screenshot (returns raw PNG bytes). Gated by host hooks. */
	async screenshot(): Promise<Buffer> {
		if (this.hooks.screenshotAllowed && !this.hooks.screenshotAllowed()) {
			throw new BrowserError("screenshot_blocked", "Screenshot delivery is disabled by the image policy");
		}
		const { tab, page } = this.requireActivePage();
		const bytes = await page.screenshot({ type: "png" }).catch((error: unknown) => {
			throw translateActionError("screenshot", error);
		});
		this.audit("BROWSER_ACTION", { action: "screenshot", tab_id: tab.id, outcome: "taken" });
		return bytes;
	}

	async waitFor(input: { urlSubstring?: string; ms?: number }): Promise<string> {
		const { page } = this.requireActivePage();
		const started = Date.now();
		if (input.urlSubstring) {
			await page
			 .waitForURL(new RegExp(escapeRegExp(input.urlSubstring)), { timeout: input.ms ?? 10_000 })
			 .catch((error: unknown) => {
				 throw new BrowserError("wait_timeout", `URL did not match "${input.urlSubstring}": ${error instanceof Error ? error.message : String(error)}`);
			 });
		} else if (input.ms) {
			await page.waitForTimeout(Math.max(0, Math.min(30_000, input.ms)));
		}
		return `waited ${Date.now() - started}ms; url=${page.url()}`;
	}

	async use(tabId: string): Promise<BrowserTabInfo> {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new BrowserError("unknown_tab", `Unknown tab: ${tabId}`);
		this.setActiveTabId(tabId, true);
		this.audit("BROWSER_TAB_ACTIVATED", { tab_id: tabId });
		return this.tabInfo(tab);
	}

	async close(target: string | undefined): Promise<{ closed: string[] }> {
		if (target === "all" || (!target && this.tabs.size === 0)) {
			const ids = [...this.tabs.keys()];
			for (const id of ids) await this.closeTabById(id, "user");
			return { closed: ids };
		}
		const id = target ?? this.activeTabId;
		if (!id) return { closed: [] };
		if (!this.tabs.has(id)) {
			throw new BrowserError("unknown_tab", `Unknown tab: ${id}`);
		}
		await this.closeTabById(id, "user");
		return { closed: [id] };
	}

	private async closeTabById(id: string, reason: string): Promise<void> {
		const tab = this.tabs.get(id);
		if (!tab) return;
		const page = this.context?.pages().find((p) => (p as unknown as { __pizzaTabId?: string }).__pizzaTabId === id);
		if (page) {
			await page.close().catch(() => {});
		}
		// page.on("close") handler removes it from the registry; fall back:
		if (this.tabs.delete(id)) {
			if (this.activeTabId === id) {
				const next = [...this.tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
				this.setActiveTabId(next?.id, true);
			}
			this.audit("BROWSER_TAB_CLOSED", { tab_id: id, reason });
			this.emitControl({ type: "tab_closed", tabId: id });
			this.emitControl({ type: "tabs", tabs: this.listTabs() });
		}
	}

	// ------------------------------------------------------------------
	// Frame channel (screencast + client input)
	// ------------------------------------------------------------------

	attachFrameSink(sink: FrameSink): () => void {
		this.frameSinks.add(sink);
		return () => this.frameSinks.delete(sink);
	}

	attachControlListener(listener: ControlListener): () => void {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	setPanelVisible(visible: boolean): void {
		this.panelVisible = visible;
		if (visible) {
			void this.restartScreencast();
		} else {
			this.stopScreencast();
		}
	}

	setAgentActive(active: boolean): void {
		this.agentActive = active;
		this.emitControl({ type: "agent_active", active });
	}

	private stopScreencast(): void {
		const disposable = this.screencastDisposable;
		this.screencastDisposable = undefined;
		if (disposable) void disposable.dispose().catch(() => {});
	}

	private async restartScreencast(): Promise<void> {
		this.stopScreencast();
		if (!this.panelVisible || !this.context) return;
		const tab = this.activeTab;
		if (!tab) return;
		const page = this.context.pages().find((p) => (p as unknown as { __pizzaTabId?: string }).__pizzaTabId === tab.id);
		if (!page) return;
		try {
			const disposable = await page.screencast.start({
				quality: SCREAMCAST_QUALITY,
				onFrame: ({ data, viewportWidth, viewportHeight }) => {
					const frameId = ++this.frameCounter;
					const frame = {
						tabId: tab.id,
						frameId,
						width: viewportWidth,
						height: viewportHeight,
						data,
					};
					this.emitControl({
						type: "frame_meta",
						tabId: tab.id,
						frameId,
						width: viewportWidth,
						height: viewportHeight,
					});
					for (const sink of this.frameSinks) {
						try {
							sink(frame);
						} catch {
							// Sink errors must not break the frame loop.
						}
					}
				},
			});
			if (this.panelVisible && this.activeTabId === tab.id) {
				this.screencastDisposable = disposable;
			} else {
				void disposable.dispose().catch(() => {});
			}
		} catch {
			// Screencast is best-effort; the panel just shows no frames.
		}
	}

	/** Dispatch an input event forwarded from the frame channel. */
	async dispatchInput(event: BrowserInputEvent, tabId?: string): Promise<void> {
		const target = tabId ?? this.activeTabId;
		const tab = target ? this.tabs.get(target) : undefined;
		if (!tab || !this.context) return;
		const page = this.context.pages().find((p) => (p as unknown as { __pizzaTabId?: string }).__pizzaTabId === tab.id);
		if (!page) return;
		const button = event.button ?? "left";
		try {
			switch (event.kind) {
				case "mousedown":
					await page.mouse.move(event.x ?? 0, event.y ?? 0);
					await page.mouse.down({ button });
					break;
				case "mouseup":
					await page.mouse.move(event.x ?? 0, event.y ?? 0);
					await page.mouse.up({ button });
					break;
				case "mousemove":
					await page.mouse.move(event.x ?? 0, event.y ?? 0);
					break;
				case "click":
					await page.mouse.click(event.x ?? 0, event.y ?? 0, { button });
					break;
				case "dblclick":
					await page.mouse.dblclick(event.x ?? 0, event.y ?? 0, { button });
					break;
				case "wheel":
					await page.mouse.wheel(event.deltaX ?? 0, event.deltaY ?? 0);
					break;
				case "keydown":
					if (event.key) await page.keyboard.down(normalizeKeyName(event.key));
					break;
				case "keyup":
					if (event.key) await page.keyboard.up(normalizeKeyName(event.key));
					break;
			}
			if (event.kind === "click" || event.kind === "dblclick" || event.kind === "keyup") {
				this.invalidateSnapshot();
			}
		} catch {
			// Input dispatch races page navigation; drop silently.
		}
	}

	// ------------------------------------------------------------------
	// Downloads
	// ------------------------------------------------------------------

	private async handleDownload(download: import("playwright-core").Download, tab: ManagedTab): Promise<void> {
		const dir = path.join(getAgentDir(), "browser", "downloads");
		await mkdir(dir, { recursive: true });
		const filename = sanitizeFilename(download.suggestedFilename());
		const target = path.join(dir, `${Date.now()}-${filename}`);
		await download.saveAs(target).catch(() => {});
		const size = await download
			.failure()
			.then(() => 0)
			.catch(() => 0);
		const record = { filename, path: target, size, at: Date.now(), tabId: tab.id };
		this.downloads.push(record);
		if (this.downloads.length > 50) this.downloads.shift();
		this.audit("BROWSER_ACTION", {
			action: "download_saved",
			tab_id: tab.id,
			filename,
			outcome: "saved",
		});
	}

	listDownloads(): ControllerState["downloads"] {
		return [...this.downloads];
	}

	// ------------------------------------------------------------------
	// Teardown
	// ------------------------------------------------------------------

	/** Stop everything: close Chromium, forget approvals, audit the end. */
	async emergencyStop(): Promise<void> {
		this.stopScreencast();
		this.policy.reset();
		const browser = this.browser;
		this.browser = undefined;
		this.context = undefined;
		// Drop the completed launch promise too: ensureBrowser() treats a
		// settled `launching` as "already up" and would skip relaunching,
		// leaving the engine permanently dead after a stop.
		this.launching = undefined;
		this.tabs.clear();
		this.activeTabId = undefined;
		this.emitControl({ type: "tabs", tabs: [] });
		if (browser) {
			await browser.close().catch(() => {});
		}
		this.audit("BROWSER_SESSION_ENDED", { outcome: "emergency_stop" });
	}

	private async ensureSnapshot(page: import("playwright-core").Page): Promise<void> {
		const tab = this.activeTab;
		if (tab?.snapshot === undefined) {
			const text = await page.ariaSnapshot({ mode: "ai" }).catch(() => "");
			if (tab) tab.snapshot = text || undefined;
		}
	}

	/**
	 * Actions can change the page without a navigation (JS handlers, SPA
	 * updates), which the framenavigated-based invalidation cannot see. Drop
	 * the cached snapshot after every state-changing action so the next
	 * `_browser snapshot` reflects reality.
	 */
	private invalidateSnapshot(): void {
		const tab = this.activeTab;
		if (tab) tab.snapshot = undefined;
	}

	private validateCoordinates(input: { x?: number; y?: number; frameId?: number }): void {
		if (typeof input.x !== "number" || typeof input.y !== "number") {
			throw new BrowserError("missing_coordinates", "Coordinate actions need --x and --y");
		}
		if (typeof input.frameId !== "number") {
			throw new BrowserError(
				"stale_frame",
				"Coordinate actions require --frame <id> from the latest visible frame (take a screenshot or read frame_meta first)",
			);
		}
		if (input.frameId !== this.frameCounter) {
			throw new BrowserError(
				"stale_frame",
				`Frame ${input.frameId} is stale (latest is ${this.frameCounter}) — coordinates must come from the current frame`,
			);
		}
	}
}

/** Accept "e3" or "@e3" or "[ref=e3]" forms. */
function normalizeRef(ref: string): string {
	const match = /(?:@?)\[?ref=(e[\dFf]+)\]?/.exec(ref.trim());
	if (match) return match[1];
	const bare = ref.trim().replace(/^@/, "");
	return /^e[\dFf]+$/.test(bare) ? bare : bare;
}

/** Map DOM KeyboardEvent.key values to Playwright key names. */
function normalizeKeyName(key: string): string {
	if (key === "Space" || key === " ") return " ";
	if (key === "OS" || key === "Meta") return "Meta";
	if (key === "Del") return "Delete";
	if (key === "Esc") return "Escape";
	return key;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translateActionError(action: string, error: unknown): BrowserError {
	const message = error instanceof Error ? error.message : String(error);
	if (/timeout/i.test(message)) {
		return new BrowserError("action_timeout", `${action} timed out: ${message}`);
	}
	if (/strict mode/i.test(message)) {
		return new BrowserError("ambiguous_ref", `${action}: ref matched multiple elements — re-snapshot and use a unique ref`);
	}
	if (/ref/i.test(message) && /not found|resolve|unknown/i.test(message)) {
		return new BrowserError("stale_ref", `${action}: ref not found — re-run _browser snapshot after the page changed`);
	}
	return new BrowserError("action_failed", `${action} failed: ${message}`);
}

/** Process-wide controller accessor (single sidecar == single engine). */
export function getBrowserController(): BrowserController {
	return BrowserController.getInstance();
}
