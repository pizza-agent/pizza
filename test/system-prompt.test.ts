import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/context/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
			expect(prompt).toContain("## Environment");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
			expect(prompt).toContain("## Environment");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					cli: "Execute CLI commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- cli:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
	describe("main agent prefix", () => {
		test("injects the user profile as an About the User section after Identity", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				soulFile: { path: "/main/SOUL.md", content: "You are Nova." },
				userProfile: { path: "/main/memory/user-profile.md", content: "# User Profile\n- Name: Tom" },
			});

			expect(prompt).toContain("# Identity\n\nYou are Nova.");
			expect(prompt).toContain("# About the User\n\n## /main/memory/user-profile.md\n\n# User Profile\n- Name: Tom");
			expect(prompt.indexOf("# Identity")).toBeLessThan(prompt.indexOf("# About the User"));
		});

		test("truncates an oversized user profile and points at the full file", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				userProfile: { path: "/main/memory/user-profile.md", content: `h${"x".repeat(3000)}t` },
			});

			expect(prompt).toContain("# About the User");
			expect(prompt).toContain("truncated — the full profile is at /main/memory/user-profile.md");
			expect(prompt).not.toContain("x".repeat(2100));
		});

		test("omits the About the User section when no profile is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				soulFile: { path: "/main/SOUL.md", content: "# Identity\nYou are Nova." },
			});

			expect(prompt).not.toContain("About the User");
		});
	});

	describe("event store path", () => {
		test("surfaces the event store path in the Environment section when provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				eventStorePath: "~/.pizza/agent/workspaces/ws_abc123/events.sqlite",
			});

			expect(prompt).toContain(
				"- Workspace event store (session history/logs; browse via _history_tree): ~/.pizza/agent/workspaces/ws_abc123/events.sqlite",
			);
		});

		test("omits the event store line when no path is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("Workspace event store");
		});
	});
});
