/**
 * Regression guard: the browser panel i18n block must be exactly one level
 * deep (browser.<key> → string). A double-nested block (browser.browser.<key>)
 * renders raw key names in the UI — the exact bug seen on first launch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_KEYS = [
	"title",
	"noTabs",
	"closeTab",
	"agentActive",
	"stop",
	"addressPlaceholder",
	"go",
	"connecting",
	"emptyHint",
	"connectionError",
	"panelHidden",
	"statusIdle",
	"engineRunning",
	"engineIdle",
	"navigationFailed",
] as const;

for (const locale of ["en", "zh-CN"]) {
	describe(`browser pane i18n (${locale})`, () => {
		const data = JSON.parse(
			readFileSync(join(__dirname, `../apps/web/src/i18n/locales/${locale}.json`), "utf-8"),
		) as Record<string, unknown>;

		it("has a flat browser.<key> block with all panel keys", () => {
			const browser = data["browser"];
			expect(browser, "browser block must exist").toBeTypeOf("object");
			for (const key of REQUIRED_KEYS) {
				const value = (browser as Record<string, unknown>)[key];
				expect(value, `browser.${key} must be a string (was: ${JSON.stringify(value)})`).toBeTypeOf("string");
				expect((value as string).length).toBeGreaterThan(0);
			}
		});

		it("is not double-nested (browser.browser would render raw key names)", () => {
			expect((data["browser"] as Record<string, unknown>)["browser"]).toBeUndefined();
		});
	});
}
