/**
 * Native browser bridge — routes `_browser` agent commands to the desktop's
 * embedded child webview when the frontend announces native mode
 * (`browser_set_native {enabled: true}`).
 *
 * Flow: sidecar emits a BROWSER_NATIVE_CMD event (nonce-correlated) on the
 * RPC stream → the BrowserPane executes it (navigate via Tauri command, or
 * in-page JS via the bridge) → posts `browser_native_result` back → the
 * pending promise here resolves. Without a live native pane (web build,
 * closed panel), the bridge is absent and `_browser` falls back to the
 * managed-Chromium engine.
 */

export type NativeBridgeCommandKind = "navigate" | "close" | "exec" | "activate" | "tabs";

export interface NativeBridgeCommand {
	nonce: string;
	kind: NativeBridgeCommandKind;
	payload?: { url?: string; code?: string; tabId?: string; newTab?: boolean };
}

export interface NativeBridgeResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface NativeBridge {
	/** Emit the command to the frontend (writeRawStdout path in rpc-mode). */
	send(command: NativeBridgeCommand): void;
}

const RESULT_TIMEOUT_MS = 30_000;

class NativeBridgeSession {
	private readonly bridge: NativeBridge;
	private readonly pending = new Map<string, { resolve: (r: NativeBridgeResult) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(bridge: NativeBridge) {
		this.bridge = bridge;
	}

	/** Called by rpc-mode when the frontend posts browser_native_result. */
	resolveResult(nonce: string, result: NativeBridgeResult): void {
		const entry = this.pending.get(nonce);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(nonce);
		entry.resolve(result);
	}

	private request(kind: NativeBridgeCommandKind, payload?: NativeBridgeCommand["payload"]): Promise<NativeBridgeResult> {
		const nonce = `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		return new Promise<NativeBridgeResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(nonce);
				resolve({ ok: false, error: `native bridge command timed out after ${RESULT_TIMEOUT_MS}ms (panel open?)` });
			}, RESULT_TIMEOUT_MS);
			this.pending.set(nonce, { resolve, timer });
			this.bridge.send({ nonce, kind, payload });
		});
	}

	async navigate(url: string, options: { newTab?: boolean } = {}): Promise<NativeBridgeResult> {
		return this.request("navigate", { url, newTab: options.newTab });
	}

	async close(tabId?: string): Promise<NativeBridgeResult> {
		return this.request("close", tabId ? { tabId } : undefined);
	}

	async activate(tabId: string): Promise<NativeBridgeResult> {
		return this.request("activate", { tabId });
	}

	async tabs(): Promise<NativeBridgeResult> {
		return this.request("tabs");
	}

	async exec(code: string): Promise<NativeBridgeResult> {
		return this.request("exec", { code });
	}
}

// ---------------------------------------------------------------------------
// In-page script generators (run inside the embedded page via the bridge)
// ---------------------------------------------------------------------------

function pageExpr(body: string): string {
	// Wrapped as an expression for __pizzaExec's eval.
	return `(function(){ ${body} })()`;
}

/** ARIA-ish snapshot with [ref=eN] for interactive elements (v1 engine). */
export function snapshotCode(): string {
	return pageExpr(`
		var refs = {}; var n = 0; var out = [];
		function roleOf(el){
			var t = el.tagName ? el.tagName.toLowerCase() : '';
			var r = el.getAttribute ? el.getAttribute('role') : null;
			if (r) return r;
			if (t === 'a') return 'link';
			if (t === 'button') return 'button';
			if (t === 'input') return (el.type === 'button' || el.type === 'submit') ? 'button' : 'textbox';
			if (t === 'textarea') return 'textbox';
			if (t === 'select') return 'combobox';
			if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4') return 'heading';
			if (el.hasAttribute && el.hasAttribute('onclick')) return 'button';
			return null;
		}
		function nameOf(el){
			var v = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))) ||
				(el.alt || '') || (el.innerText || el.value || '');
			return String(v).replace(/\\s+/g, ' ').trim().slice(0, 80);
		}
		function visible(el){
			try {
				var s = getComputedStyle(el);
				if (s.display === 'none' || s.visibility === 'hidden') return false;
				var r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			} catch (e) { return false; }
		}
		var nodes = document.querySelectorAll('a, button, input, textarea, select, [role], [onclick], h1, h2, h3, h4');
		for (var i = 0; i < nodes.length && out.length < 200; i++) {
			var el = nodes[i];
			if (!visible(el)) continue;
			var role = roleOf(el); if (!role) continue;
			var name = nameOf(el);
			var ref = 'e' + (++n);
			refs[ref] = el;
			out.push('- ' + role + (name ? ' "' + name + '"' : '') + ' [ref=' + ref + ']');
		}
		window.__pizzaRefs = refs;
		var body = String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 1500);
		return (out.join('\\n') || '(no interactive elements)') + (body ? '\\n\\n# page text\\n' + body : '');
	`);
}

export function clickCode(ref: string): string {
	const safe = ref.replace(/[^e\dFf]/g, "");
	return pageExpr(`
		var el = window.__pizzaRefs && window.__pizzaRefs[${JSON.stringify(safe)}];
		if (!el) throw new Error('unknown ref — re-run _browser snapshot');
		el.scrollIntoView({ block: 'center' });
		el.click();
		return 'clicked ' + ${JSON.stringify(safe)};
	`);
}

export function typeCode(ref: string, text: string): string {
	const safe = ref.replace(/[^e\dFf]/g, "");
	const escaped = JSON.stringify(text);
	return pageExpr(`
		var el = window.__pizzaRefs && window.__pizzaRefs[${JSON.stringify(safe)}];
		if (!el) throw new Error('unknown ref — re-run _browser snapshot');
		el.focus();
		el.value = ${escaped};
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return 'typed ' + ${escaped}.length + ' chars';
	`);
}

export function keyCode(key: string): string {
	const escaped = JSON.stringify(key);
	return pageExpr(`
		var target = document.activeElement || document.body;
		var ev = new KeyboardEvent('keydown', { key: ${escaped}, bubbles: true, cancelable: true });
		target.dispatchEvent(ev);
		if (${escaped} === 'Enter') {
			var form = target.closest ? target.closest('form') : null;
			if (form && form.requestSubmit) { try { form.requestSubmit(); return 'submitted'; } catch (e) {} }
		}
		target.dispatchEvent(new KeyboardEvent('keyup', { key: ${escaped}, bubbles: true }));
		return 'pressed ' + ${escaped};
	`);
}

export function scrollCode(direction: "up" | "down", amount: number): string {
	const delta = direction === "up" ? -amount : amount;
	return pageExpr(`
		window.scrollBy({ top: ${delta}, behavior: 'smooth' });
		return 'scrolled ${direction} ${amount}';
	`);
}

// ---------------------------------------------------------------------------
// Session registry (set/cleared by rpc-mode on browser_set_native)
// ---------------------------------------------------------------------------

let activeSession: NativeBridgeSession | undefined;

export function setNativeBridge(bridge: NativeBridge | undefined): void {
	activeSession = bridge ? new NativeBridgeSession(bridge) : undefined;
}

export function hasNativeBridge(): boolean {
	return activeSession !== undefined;
}

export function resolveNativeResult(nonce: string, result: NativeBridgeResult): void {
	activeSession?.resolveResult(nonce, result);
}

/** Run a `_browser` action through the native bridge; throws when absent. */
export async function runNative(
	action: "navigate" | "close" | "snapshot" | "click" | "type" | "key" | "scroll" | "activate" | "tabs",
	args: { url?: string; newTab?: boolean; tabId?: string; ref?: string; text?: string; key?: string; direction?: "up" | "down"; amount?: number } = {},
): Promise<string> {
	if (!activeSession) throw new Error("native bridge unavailable");
	let result: NativeBridgeResult;
	switch (action) {
		case "navigate":
			result = await activeSession.navigate(args.url ?? "", { newTab: args.newTab });
			break;
		case "close":
			result = await activeSession.close(args.tabId);
			break;
		case "activate":
			result = await activeSession.activate(args.tabId ?? "");
			break;
		case "tabs":
			result = await activeSession.tabs();
			break;
		case "snapshot":
			result = await activeSession.exec(snapshotCode());
			break;
		case "click":
			result = await activeSession.exec(clickCode(args.ref ?? ""));
			break;
		case "type":
			result = await activeSession.exec(typeCode(args.ref ?? "", args.text ?? ""));
			break;
		case "key":
			result = await activeSession.exec(keyCode(args.key ?? "Enter"));
			break;
		case "scroll":
			result = await activeSession.exec(scrollCode(args.direction ?? "down", args.amount ?? 600));
			break;
	}
	if (!result.ok) throw new Error(result.error ?? "native bridge command failed");
	return typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "ok");
}
