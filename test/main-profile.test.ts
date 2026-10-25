import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeMainAgent } from "../src/core/agent/main-agent.js";
import { listMainJournals, loadMainProfile, readMainDocument, writeMainDocument } from "../src/core/agent/main-profile.js";

describe("main agent profile", () => {
	let dir: string;
	let roots: { mainDir: string; memoryDir: string };
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-main-profile-"));
		roots = { mainDir: join(dir, "main"), memoryDir: join(dir, "main", "memory") };
		initializeMainAgent(roots.mainDir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("requires backend main capability on every read", async () => {
		await expect(loadMainProfile()).rejects.toThrow("main agent session");
		await expect(readMainDocument(undefined, "SOUL.md")).rejects.toThrow("main agent session");
		await expect(listMainJournals(undefined)).rejects.toThrow("main agent session");
	});
	it("projects real identity, preference sources, and stale/unindexed entries without changing files", async () => {
		writeFileSync(join(roots.mainDir, "SOUL.md"), "---\ndescription: metadata, not identity\n---\n# Identity\n\nName: Atlas\n\nBe direct and curious.");
		writeFileSync(join(roots.memoryDir, "user-profile.md"), "# User profile\n\n中文，回答简洁。");
		writeFileSync(join(roots.memoryDir, "_index.md"), "# Memory\n- user-profile.md — Preferences\n- missing.md — Old project\n");
		writeFileSync(join(roots.memoryDir, "new.md"), "# New finding\n\nA real detail.");
		const before = readFileSync(join(roots.memoryDir, "_index.md"), "utf8");
		const result = await loadMainProfile(roots);
		expect(result.soul).toMatchObject({ name: "Atlas", initialized: true, sourceId: "SOUL.md" });
		expect(result.soul.summary).not.toContain("metadata");
		expect(result.userProfile).toEqual({ sourceId: "memory/user-profile.md", summary: "中文，回答简洁。" });
		expect(result.memories).toEqual(expect.arrayContaining([
			expect.objectContaining({ sourceId: "memory/missing.md", status: "stale" }),
			expect.objectContaining({ sourceId: "memory/new.md", status: "unindexed", title: "New finding" }),
		]));
		expect(readFileSync(join(roots.memoryDir, "_index.md"), "utf8")).toBe(before);
	});
	it("does not invent a name or a relationship date for placeholders", async () => {
		const result = await loadMainProfile(roots);
		expect(result.soul.initialized).toBe(false);
		expect(result.soul.name).toBeUndefined();
		expect(result.userProfile?.summary).toBe("");
		expect(result).not.toHaveProperty("since");
	});
	it("blocks traversal, absolute paths, non-markdown files and symlink escapes", async () => {
		writeFileSync(join(dir, "outside.md"), "private");
		symlinkSync(join(dir, "outside.md"), join(roots.memoryDir, "escape.md"));
		for (const source of ["../outside.md", "memory/../../outside.md", "memory/./user-profile.md", "memory\\user-profile.md", "/tmp/file.md", "memory/key.json", "memory/escape.md"]) {
			await expect(readMainDocument(roots, source)).rejects.toThrow();
		}
		rmSync(join(roots.memoryDir, "journal"), { recursive: true });
		symlinkSync(dir, join(roots.memoryDir, "journal"), "dir");
		await expect(listMainJournals(roots)).rejects.toThrow("outside memory");
	});
	it("bounds document reads and identifies unavailable memory without hiding the problem", async () => {
		writeFileSync(join(roots.memoryDir, "big.md"), "x".repeat(512 * 1024 + 1));
		await expect(readMainDocument(roots, "memory/big.md")).rejects.toThrow("512 KiB");
		expect((await loadMainProfile(roots)).memories).toContainEqual(expect.objectContaining({ sourceId: "memory/big.md", status: "unavailable" }));
	});
	it("reads journals separately, ignores invalid calendar dates and pages without duplicates", async () => {
		for (const day of ["2026-10-25", "2026-10-24", "2026-10-23", "2026-02-30", "2026-99-99"]) {
			writeFileSync(join(roots.memoryDir, "journal", `${day}.md`), `# Day ${day}\n\nWe learned something.`);
		}
		const page = await listMainJournals(roots, undefined, 2);
		expect(page.entries.map((entry) => entry.date)).toEqual(["2026-10-25", "2026-10-24"]);
		expect(page.nextBefore).toBe("2026-10-24");
		const next = await listMainJournals(roots, page.nextBefore, 2);
		expect(next.entries.map((entry) => entry.date)).toEqual(["2026-10-23"]);
		expect(next.nextBefore).toBeUndefined();
		expect((await loadMainProfile(roots)).memories.some((entry) => entry.sourceId.includes("journal/"))).toBe(false);
		await expect(listMainJournals(roots, "../../escape")).rejects.toThrow("cursor");
		await expect(listMainJournals(roots, undefined, 1000)).rejects.toThrow("limit");
	});
	it("saves the full source with a new revision and refreshes the projection", async () => {
		const original = await readMainDocument(roots, "SOUL.md");
		const content = "---\ntags: [identity]\n---\n# Identity\n\nName: Nova\n\n清楚、直接。\n";
		const saved = await writeMainDocument(roots, "SOUL.md", content, original.revision);
		expect(saved.content).toBe(content);
		expect(saved.revision).not.toBe(original.revision);
		expect(readFileSync(join(roots.mainDir, "SOUL.md"), "utf8")).toBe(content);
		expect((await loadMainProfile(roots)).soul).toMatchObject({ initialized: true, name: "Nova" });
		expect(readdirSync(roots.mainDir).some((name) => name.startsWith(".agent-edit-"))).toBe(false);
	});
	it("does not overwrite a source changed by another editor", async () => {
		const original = await readMainDocument(roots, "memory/user-profile.md");
		writeFileSync(original.path, "# User Profile\n\nExternal edit");
		await expect(writeMainDocument(roots, original.sourceId, "My draft", original.revision)).rejects.toThrow("DOCUMENT_CONFLICT");
		expect(readFileSync(original.path, "utf8")).toContain("External edit");
	});
	it("serializes conflicting saves so exactly one revision wins", async () => {
		const original = await readMainDocument(roots, "SOUL.md");
		const results = await Promise.allSettled([
			writeMainDocument(roots, "SOUL.md", "# First edit", original.revision),
			writeMainDocument(roots, "SOUL.md", "# Second edit", original.revision),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it("rejects unsafe, unversioned and oversized writes without touching source files", async () => {
		const original = await readMainDocument(roots, "SOUL.md");
		await expect(writeMainDocument(undefined, "SOUL.md", "edit", original.revision)).rejects.toThrow("main agent session");
		await expect(writeMainDocument(roots, "SOUL.md", "edit", "")).rejects.toThrow("revision");
		await expect(writeMainDocument(roots, "SOUL.md", "x".repeat(512 * 1024 + 1), original.revision)).rejects.toThrow("512 KiB");
		writeFileSync(join(dir, "outside.md"), "Keep me");
		symlinkSync(join(dir, "outside.md"), join(roots.memoryDir, "escape.md"));
		for (const id of ["memory/../../outside.md", "memory/escape.md", "memory/../SOUL.md"]) {
			await expect(writeMainDocument(roots, id, "edit", original.revision)).rejects.toThrow();
		}
		expect(readFileSync(join(dir, "outside.md"), "utf8")).toBe("Keep me");
		expect((await readMainDocument(roots, "SOUL.md")).content).toBe(original.content);
	});

	it("supports a configured external memory root without allowing paths outside it", async () => {
		roots.memoryDir = join(dir, "custom-memory");
		mkdirSync(roots.memoryDir);
		writeFileSync(join(roots.memoryDir, "topic.md"), "# Custom root");
		expect((await readMainDocument(roots, "memory/topic.md")).content).toBe("# Custom root");
	});
});
