import { Editor, visibleWidth, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../src/core/keybindings.js";
import { theme } from "../theme/theme.js";

/** Strip ANSI escape sequences for visible-text checks. */
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Check if a rendered line is a border rule (plain ─ run or "↑/↓ N more" scroll hint). */
function isBorderLine(line: string): boolean {
	const s = stripAnsi(line);
	return /^─+$/.test(s) || /^─+\s*[↑↓]\s*\d+\s*more\s*─*$/.test(s);
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	/**
	 * Override render to draw an asymmetric frame: the left side is open and
	 * shows a `❯` prompt on the first content line, while the right side is a
	 * full border (┐ / │ / ┘). The parent renders plain full-width ─── rules
	 * with no side borders, so we render 3 columns narrower and splice in the
	 * prompt marker and right edge ourselves.
	 */
	render(width: number): string[] {
		// Need room for "> ", "│", and at least a couple columns of text.
		if (width < 6) return super.render(width);

		const innerWidth = width - 3;
		const lines = super.render(innerWidth);
		if (lines.length < 2) return lines;

		// The last border line (plain rule or "↓ N more" scroll hint) is the
		// bottom border; anything after it is the autocomplete popup.
		let bottomIdx = -1;
		for (let i = lines.length - 1; i >= 1; i--) {
			if (isBorderLine(lines[i]!)) {
				bottomIdx = i;
				break;
			}
		}
		if (bottomIdx === -1) return super.render(width);

		const out: string[] = [this.frameBorder(lines[0]!, "┐", innerWidth)];
		for (let i = 1; i < bottomIdx; i++) {
			const marker = i === 1 ? this.promptMarker() : "  ";
			out.push(marker + lines[i] + this.borderColor("│"));
		}
		out.push(this.frameBorder(lines[bottomIdx]!, "┘", innerWidth));

		// Autocomplete popup lines: indent to sit under the editor text.
		for (let i = bottomIdx + 1; i < lines.length; i++) {
			out.push("  " + lines[i] + " ".repeat(Math.max(0, width - 2 - visibleWidth(lines[i]!))));
		}
		return out;
	}

	/** Build a full-width horizontal rule ending in the given corner, preserving scroll hints. */
	private frameBorder(line: string, corner: string, innerWidth: number): string {
		if (/[↑↓]/.test(stripAnsi(line))) {
			return this.borderColor("──") + line + this.borderColor(corner);
		}
		return this.borderColor("─".repeat(innerWidth + 2) + corner);
	}

	private promptMarker(): string {
		return theme.fg("accent", "❯") + " ";
	}
}
