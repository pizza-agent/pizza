/**
 * NativeBrowserView — the multi-tab embedded browser pane for the Tauri
 * desktop (ZCode-IAB parity).
 *
 * Each tab is a real child webview owned by the Rust host, rendered
 * natively over this component's placeholder area. This component:
 *  - reserves the viewport rect and keeps the tab webviews positioned over
 *    it (ResizeObserver + window-size changes; the rect applies to all tabs)
 *  - exposes tab lifecycle helpers (open/navigate/activate/close)
 *  - listens for per-tab page/title lifecycle events from the host
 *  - exposes `execBridge(tabId, code)` for the agent control bridge
 */

import { useCallback, useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/platform";

export interface NativeTabPatch {
	tabId: string;
	url?: string;
	title?: string;
	loading?: boolean;
}

export function isNativeBrowserAvailable(): boolean {
	return isTauri();
}

/** Fire a browser-view Tauri command from anywhere in the pane. */
export async function invokeNative(
	command: string,
	args?: Record<string, unknown>,
): Promise<unknown> {
	return tauriInvoke(command, args);
}

/** Normalize address-bar input like a browser: bare hosts get https://. */
export function normalizeAddressInput(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return trimmed;
	if (trimmed.includes("://") || trimmed === "about:blank") return trimmed;
	return `https://${trimmed}`;
}

export async function openNativeTab(tabId: string, url: string): Promise<void> {
	await invokeNative("browser_view_open_tab", { tabId, url: normalizeAddressInput(url) });
}

export async function navigateNativeTab(tabId: string, url: string): Promise<void> {
	await invokeNative("browser_view_navigate", { tabId, url: normalizeAddressInput(url) });
}

export async function activateNativeTab(tabId: string): Promise<void> {
	await invokeNative("browser_view_activate_tab", { tabId });
}

/** Close one tab; resolves with the remaining tab ids. */
export async function closeNativeTab(tabId: string): Promise<string[]> {
	const remaining = await invokeNative("browser_view_close_tab", { tabId });
	return Array.isArray(remaining) ? (remaining as string[]) : [];
}

/** Send JS to a tab's bridge; resolves with the result payload. */
export function execBrowserBridge(tabId: string, code: string, timeoutMs = 15000): Promise<unknown> {
	const id = `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return new Promise<unknown>((resolve, reject) => {
		let unlisten: UnlistenFn | undefined;
		const timer = setTimeout(() => {
			unlisten?.();
			reject(new Error(`bridge exec timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		void listen<{ id: string; ok: boolean; result?: unknown; error?: string }>(
			"browser-view-bridge",
			(event) => {
				if (event.payload?.id !== id) return;
				clearTimeout(timer);
				unlisten?.();
				if (event.payload.ok) resolve(event.payload.result);
				else reject(new Error(event.payload.error ?? "bridge exec failed"));
			},
		).then((fn) => {
			unlisten = fn;
		});
		void invokeNative("browser_view_exec", { tabId, id, code }).catch((e: unknown) => {
			clearTimeout(timer);
			unlisten?.();
			reject(e instanceof Error ? e.message : String(e));
		});
	});
}

export default function NativeBrowserView({
	onTabPatch,
}: {
	onTabPatch?: (patch: NativeTabPatch) => void;
}) {
	const placeholderRef = useRef<HTMLDivElement | null>(null);

	const syncRect = useCallback(() => {
		const el = placeholderRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		void invokeNative("browser_view_set_rect", {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		}).catch(() => {});
	}, []);

	useEffect(() => {
		let disposed = false;
		const setup = (): void => {
			if (!disposed) syncRect();
		};
		setup();

		// WKWebView renderers can freeze mid-live-resize (WebKit bug 323132);
		// once the resize settles (no events for 300ms) poke the active tab
		// via browser_view_refresh so its content repaints.
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleWake = (): void => {
			if (settleTimer !== undefined) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = undefined;
				void invokeNative("browser_view_refresh").catch(() => {});
			}, 300);
		};

		const observer = new ResizeObserver(() => {
			syncRect();
			scheduleWake();
		});
		if (placeholderRef.current) observer.observe(placeholderRef.current);
		const onWindowResize = (): void => {
			syncRect();
			scheduleWake();
		};
		window.addEventListener("resize", onWindowResize);
		const timers = [50, 150, 400, 1000].map((ms) => setTimeout(setup, ms));

		let unlistenTitle: UnlistenFn | undefined;
		let unlistenPage: UnlistenFn | undefined;
		void listen<{ tabId: string; title: string; url: string }>("browser-view-title", (event) => {
			onTabPatch?.({ tabId: event.payload.tabId, title: event.payload.title, url: event.payload.url });
		}).then((fn) => {
			unlistenTitle = fn;
		});
		void listen<{ tabId: string; event: string; url: string }>("browser-view-page", (event) => {
			onTabPatch?.({
				tabId: event.payload.tabId,
				url: event.payload.url,
				loading: event.payload.event === "started",
			});
		}).then((fn) => {
			unlistenPage = fn;
		});

		return () => {
			disposed = true;
			if (settleTimer !== undefined) clearTimeout(settleTimer);
			observer.disconnect();
			window.removeEventListener("resize", onWindowResize);
			for (const t of timers) clearTimeout(t);
			unlistenTitle?.();
			unlistenPage?.();
			void invokeNative("browser_view_set_visible", { visible: false }).catch(() => {});
		};
	}, [syncRect, onTabPatch]);

	// The child webviews render over this placeholder — fill the parent
	// (`h-full w-full`; the parent is NOT a flex container, so `flex-1` would
	// collapse to 0 height and leave the pane blank).
	return (
		<div
			ref={placeholderRef}
			className="h-full min-h-0 w-full bg-white"
			onMouseDown={(e) => {
				e.preventDefault();
			}}
		/>
	);
}
