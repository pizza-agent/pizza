import { type ApiKeyOption, type OAuthFlow, getApiKeyOptions, getOAuthFlows } from "../../../src/core/auth/oauth.js";
import { type Focusable, Container, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { AuthStorage } from "../../../src/core/auth/auth-storage.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/** A selectable entry in the two-level auth selector. */
interface AuthEntry {
	/** Provider id, or a navigation sentinel */
	id: string;
	/** Display label */
	label: string;
	/** Entry kind */
	kind: "account" | "apiKey" | "back";
}

/**
 * Two-level auth selector (pi-coding-agent style):
 *
 * Level 1 — category:
 *   → Sign in with an account
 *     Sign in with an API key
 *
 * Level 2 — providers of the chosen category (Enter opens, ← Back returns,
 * Escape at level 1 cancels). Logout mode lists stored credentials directly.
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private listContainer: Container;
	private _focused = false;

	// Focusable implementation — required so the TUI routes keyboard input here
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	private entries: AuthEntry[] = [];
	private selectedIndex: number = 0;
	private level: 1 | 2 = 1;
	private activeCategory: "account" | "apiKey" | null = null;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private onSelectCallback: (providerId: string, kind: "account" | "apiKey") => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string, kind: "account" | "apiKey") => void,
		onCancel: () => void,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const title = mode === "login" ? "Sign in to Pizza:" : "Select account to sign out:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.loadEntries();
		this.updateList();
	}

	/** Rebuild the entry list for the current level. */
	private loadEntries(): void {
		this.entries = [];

		if (this.mode === "logout") {
			// Logout: flat list of every stored credential
			for (const id of this.authStorage.list()) {
				const cred = this.authStorage.get(id);
				if (!cred) continue;
				const kind = cred.type === "oauth" ? "account" : "apiKey";
				this.entries.push({ id, label: this.displayNameFor(id, kind), kind });
			}
			return;
		}

		if (this.level === 1) {
			if (getOAuthFlows().length > 0) {
				this.entries.push({ id: "__account__", label: "Sign in with an account", kind: "account" });
			}
			if (getApiKeyOptions().length > 0) {
				this.entries.push({ id: "__apikey__", label: "Sign in with an API key", kind: "apiKey" });
			}
			return;
		}

		// Level 2: providers of the active category, with a back entry
		this.entries.push({ id: "__back__", label: "← Back", kind: "back" });
		if (this.activeCategory === "account") {
			for (const flow of getOAuthFlows()) {
				this.entries.push({ id: flow.id, label: flow.name, kind: "account" });
			}
		} else {
			const accountIds = new Set(getOAuthFlows().map((f) => f.id));
			for (const option of getApiKeyOptions()) {
				// Hide pure key-entry duplicates of account providers unless a key is stored
				const hasStoredKey = this.authStorage.get(option.id)?.type === "api_key";
				if (accountIds.has(option.id) && !hasStoredKey) continue;
				this.entries.push({ id: option.id, label: option.name, kind: "apiKey" });
			}
		}
	}

	private displayNameFor(providerId: string, kind: "account" | "apiKey"): string {
		if (kind === "account") {
			return getOAuthFlows().find((f) => f.id === providerId)?.name ?? providerId;
		}
		return getApiKeyOptions().find((o) => o.id === providerId)?.name ?? providerId;
	}

	private openCategory(kind: "account" | "apiKey"): void {
		this.activeCategory = kind;
		this.level = 2;
		this.selectedIndex = 1; // first provider under "← Back"
		this.loadEntries();
		this.updateList();
	}

	private goBack(): void {
		this.level = 1;
		this.activeCategory = null;
		this.selectedIndex = 0;
		this.loadEntries();
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		// Window the list (like ModelSelectorComponent) so long provider lists
		// (30+ API-key providers) keep the selected entry visible.
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.entries.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.entries.length);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.entries[i];
			if (!entry) continue;

			const isSelected = i === this.selectedIndex;
			const isCategory = entry.id === "__account__" || entry.id === "__apikey__";
			const isBack = entry.id === "__back__";

			let status = "";
			if (this.mode === "login" && !isCategory && !isBack) {
				const cred = this.authStorage.get(entry.id);
				if (cred?.type === "oauth") status = theme.fg("success", " ✓ signed in");
				else if (cred?.type === "api_key" && entry.kind === "apiKey") status = theme.fg("success", " ✓ key set");
			}

			const indent = isCategory || isBack ? "" : "   ";
			const marker = isSelected ? theme.fg("accent", "→ ") : "  ";
			const text = isCategory ? theme.bold(entry.label) : isBack ? theme.fg("muted", entry.label) : entry.label;
			this.listContainer.addChild(new TruncatedText(`${marker}${indent}${text}${status}`, 0, 0));
		}

		// Scroll indicator when the list is longer than the visible window
		if (endIndex < this.entries.length || startIndex > 0) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.entries.length})`), 0, 0),
			);
		}

		if (this.entries.length === 0) {
			const message =
				this.mode === "login"
					? "No auth methods available"
					: "No accounts signed in. Use /login first.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const entry = this.entries[this.selectedIndex];
			if (!entry) return;
			if (entry.id === "__account__") {
				this.openCategory("account");
			} else if (entry.id === "__apikey__") {
				this.openCategory("apiKey");
			} else if (entry.id === "__back__") {
				this.goBack();
			} else if (entry.kind !== "back") {
				this.onSelectCallback(entry.id, entry.kind);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// Escape at level 2 goes back; at level 1 (or logout) it cancels
			if (this.mode === "login" && this.level === 2) {
				this.goBack();
			} else {
				this.onCancelCallback();
			}
		}
	}
}
