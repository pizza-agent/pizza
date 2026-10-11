import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/commands/keybindings.js";
import { BrandHeaderComponent } from "../packages/tui/components/brand-header.js";
import { initTheme } from "../packages/tui/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("BrandHeaderComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the Pizza brand and startup value proposition", () => {
		const header = new BrandHeaderComponent("pizza", "1.2.3");
		const rendered = stripAnsi(header.render(90).join("\n"));

		expect(rendered).toContain("PIZZA");
		expect(rendered).toContain("v1.2.3");
		expect(rendered).toContain("Create together with Pizza.");
		expect(rendered).toContain("Read code");
	});

	it("keeps all compact and expanded lines within render width", () => {
		for (const width of [20, 45, 46, 68, 90]) {
			const header = new BrandHeaderComponent("pizza", "1.2.3", true);
			for (const line of header.render(width)) {
				expect(visibleWidth(line), `width ${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("updates rendered content when expansion changes", () => {
		const header = new BrandHeaderComponent("pizza", "1.2.3");
		expect(stripAnsi(header.render(90).join("\n"))).not.toContain("Shortcuts");

		header.setExpanded(true);
		expect(stripAnsi(header.render(90).join("\n"))).toContain("Shortcuts");
	});

	it("renders recent task history on wide headers", () => {
		const header = new BrandHeaderComponent("pizza", "1.2.3");
		header.setTaskHistory([
			{
				task_id: "task_1",
				status: "completed",
				title: "Build projection",
				summary: "Projection summarizes task events",
				updated_at: 3,
			},
			{
				task_id: "task_2",
				status: "in_progress",
				title: "Render header",
				summary: "Header shows recent tasks",
				updated_at: 2,
			},
		]);

		const rendered = header.render(120);
		const text = stripAnsi(rendered.join("\n"));

		expect(text).toContain("Recent tasks");
		expect(text).toContain("Projection summarizes task events");
		expect(text).toContain("Header shows recent tasks");
		for (const line of rendered) {
			expect(visibleWidth(line), stripAnsi(line)).toBeLessThanOrEqual(120);
		}
	});
});
