/**
 * OAuth selector focus & keyboard navigation regression test.
 *
 * The selector must implement Focusable so the TUI routes keyboard input to
 * it (up/down/enter through the two-level category → provider navigation).
 */
import { describe, expect, test } from "vitest";
import { isFocusable } from "@earendil-works/pi-tui";
import { initTheme } from "../packages/tui/theme/theme.js";
import { OAuthSelectorComponent } from "../packages/tui/components/oauth-selector.js";
import { AuthStorage } from "../src/core/auth/auth-storage.js";

describe("OAuthSelectorComponent focus", () => {
	test("API-key category windows long provider lists (selection stays visible)", () => {
		initTheme("dark", false);
		const auth = AuthStorage.inMemory();
		const sel = new OAuthSelectorComponent("login", auth, () => {}, () => {});

		// Level 1: down to "Sign in with an API key", Enter opens it
		sel.handleInput("\x1b[B");
		sel.handleInput("\r");

		// Navigate deep into the list — the windowed renderer must not throw
		// and the selection must keep advancing to real providers.
		for (let i = 0; i < 25; i++) sel.handleInput("\x1b[B");

		let deepSelected: string | undefined;
		const sel2 = new OAuthSelectorComponent(
			"login",
			auth,
			(id, kind) => {
				deepSelected = `${id}:${kind}`;
			},
			() => {},
		);
		sel2.handleInput("\x1b[B"); // level 1 → API key category
		sel2.handleInput("\r"); // open it
		for (let i = 0; i < 25; i++) sel2.handleInput("\x1b[B"); // walk deep
		sel2.handleInput("\r"); // select
		expect(deepSelected).toBeDefined();
		expect(deepSelected?.endsWith(":apiKey")).toBe(true);
	});

	test("is focusable and routes keyboard input through the two levels", () => {
		initTheme("dark", false);
		const auth = AuthStorage.inMemory();
		const sel = new OAuthSelectorComponent("login", auth, () => {}, () => {});
		expect(isFocusable(sel)).toBe(true);

		let selected: string | undefined;
		const sel2 = new OAuthSelectorComponent(
			"login",
			auth,
			(id, kind) => {
				selected = `${id}:${kind}`;
			},
			() => {},
		);
		// Enter opens the account category (cursor starts on the first provider)
		sel2.handleInput("\r");
		sel2.handleInput("\r");
		expect(selected).toBe("anthropic:account");
	});
});
