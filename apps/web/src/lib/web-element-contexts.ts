/**
 * Web element context store + composer wiring — ported from ZCode's
 * packages/ui/src/lib/webElementContext.ts / useWebElementContexts
 * (Apache-2.0, zai-org/ZCode), adapted to Pizza's composer.
 *
 * Semantics (ZCode parity):
 *  - picked elements arrive as transient in-memory attachments shown as a
 *    chip row above the composer input — NOT as text dumped into the input
 *  - on submit the contexts are spliced into the outgoing prompt as a
 *    "# Web page elements:" Markdown block; the chip is only the visual shell
 *  - contexts clear after a successful send; switching workspaces shows only
 *    that workspace's contexts; they never persist across reloads
 */

import type { WebElementContextPayload } from "./web-element-picker";

export const WEB_ELEMENT_CONTEXT_ADD_EVENT = "pizza:web-element-context-add";

export interface WebElementContextAttachment extends WebElementContextPayload {
	id: string;
}

const WEB_ELEMENT_CONTEXT_BLOCK_TITLE = "# Web page elements:";
const MAX_MARKDOWN_FIELD_LENGTH = 8_000;

// ---------------------------------------------------------------------------
// Transient store (module-level, per workspace — mirrors ZCode's composer-
// memory semantics)
// ---------------------------------------------------------------------------

const store = new Map<string, WebElementContextAttachment[]>();
const listeners = new Set<() => void>();

/** Stable empty snapshot — useSyncExternalStore requires a cached reference. */
const EMPTY: WebElementContextAttachment[] = [];

function notify(): void {
	for (const listener of listeners) listener();
}

export function subscribeWebElementContexts(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getWebElementContexts(workspace: string | null | undefined): WebElementContextAttachment[] {
	return store.get(workspace ?? "") ?? EMPTY;
}

export function addWebElementContext(
	workspace: string | null | undefined,
	payload: WebElementContextPayload,
): void {
	const key = workspace ?? "";
	const list = store.get(key) ?? [];
	list.push({ ...payload, id: createWebElementContextId() });
	store.set(key, list.slice(-8)); // sane cap, mirrors tab residency budget
	notify();
}

export function removeWebElementContext(workspace: string | null | undefined, id: string): void {
	const key = workspace ?? "";
	store.set(key, (store.get(key) ?? []).filter((context) => context.id !== id));
	notify();
}

export function clearWebElementContexts(workspace: string | null | undefined): void {
	store.set(workspace ?? "", []);  // new array: snapshot must change identity
	notify();
}

function createWebElementContextId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
	return `web-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Dispatch the add event from anywhere (the browser pane's picker). */
export function dispatchWebElementContextAdd(
	workspace: string | null | undefined,
	payload: WebElementContextPayload,
): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(WEB_ELEMENT_CONTEXT_ADD_EVENT, {
			detail: { workspace: workspace ?? "", payload },
		}),
	);
}

// ---------------------------------------------------------------------------
// Prompt composition (ZCode wire format)
// ---------------------------------------------------------------------------

function truncateMarkdownValue(value: string | undefined): string {
	if (!value) return "";
	const normalized = value.trim();
	return normalized.length > MAX_MARKDOWN_FIELD_LENGTH
		? `${normalized.slice(0, MAX_MARKDOWN_FIELD_LENGTH)}\n\n[truncated]`
		: normalized;
}

function appendOptionalLine(lines: string[], label: string, value: string | undefined): void {
	const normalized = truncateMarkdownValue(value);
	if (normalized) lines.push(`${label}: ${normalized}`);
}

function formatAttributes(attributes: Record<string, string> | undefined): string {
	if (!attributes || Object.keys(attributes).length === 0) return "";
	return Object.entries(attributes)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
}

/** One context as a "## Element" Markdown section (ZCode field-line format). */
export function buildWebElementContextMarkdown(payload: WebElementContextPayload): string {
	const lines = [
		"## Element",
		`URL: ${payload.pageUrl}`,
		`Title: ${payload.pageTitle || "(untitled)"}`,
		`Tag: ${payload.tagName.toLowerCase()}`,
	];
	appendOptionalLine(lines, "Role", payload.role);
	appendOptionalLine(lines, "Accessible name", payload.accessibleName);
	appendOptionalLine(lines, "Selector", payload.selector);
	appendOptionalLine(lines, "XPath", payload.xpath);
	appendOptionalLine(lines, "Attributes", formatAttributes(payload.attributes));
	appendOptionalLine(lines, "Color", payload.style?.color);
	appendOptionalLine(lines, "Background", payload.style?.backgroundColor);
	appendOptionalLine(lines, "Font", [payload.style?.fontSize, payload.style?.fontFamily].filter(Boolean).join(" "));
	appendOptionalLine(lines, "Font weight", payload.style?.fontWeight);
	appendOptionalLine(lines, "Display", payload.style?.display);
	if (payload.rect) {
		lines.push(
			`Rect: x=${Math.round(payload.rect.x)}, y=${Math.round(payload.rect.y)}, width=${Math.round(payload.rect.width)}, height=${Math.round(payload.rect.height)}`,
		);
	}
	const text = truncateMarkdownValue(payload.text);
	if (text) lines.push("", "Text:", "```", text, "```");
	const nearbyText = truncateMarkdownValue(payload.nearbyText);
	if (nearbyText) lines.push("", "Nearby context:", "```", nearbyText, "```");
	const htmlExcerpt = truncateMarkdownValue(payload.htmlExcerpt);
	if (htmlExcerpt) lines.push("", "HTML excerpt:", "```html", htmlExcerpt, "```");
	return lines.join("\n");
}

/** Compose the outgoing prompt: user text + one Markdown block for all
 *  contexts (ZCode's buildPromptWithWebElementContexts). */
export function buildPromptWithWebElementContexts(
	text: string,
	contexts: readonly WebElementContextAttachment[],
): string {
	const content = text.trimEnd();
	if (contexts.length === 0) return content.trim();
	const contextBlock = `${WEB_ELEMENT_CONTEXT_BLOCK_TITLE}\n\n${contexts
		.map((context, index) =>
			buildWebElementContextMarkdown(context).replace("## Element", `## Element ${index + 1}`),
		)
		.join("\n\n")}`;
	return `${content}${content ? "\n\n" : ""}${contextBlock}`.trim();
}
