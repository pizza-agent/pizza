import { describe, expect, it } from "vitest";
import {
	countDiffStats,
	fileChangeFromMutationEvent,
	fileChangesForThread,
	fileChangesFromToolEnd,
	mergeFileChanges,
	parseFileChange,
} from "../apps/web/src/lib/file-changes";

describe("file change helpers", () => {
	it("normalizes Windows paths and counts unified diff lines", () => {
		const change = parseFileChange({
			path: ".\\src\\foo.ts",
			operation: "edit",
			diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context",
		});
		expect(change).toMatchObject({
			path: "src/foo.ts",
			operation: "modify",
			additions: 2,
			deletions: 1,
		});
	});

	it("maps create/delete aliases", () => {
		expect(parseFileChange({ path: "a.ts", operation: "add" })?.operation).toBe("create");
		expect(parseFileChange({ path: "b.ts", operation: "remove" })?.operation).toBe("delete");
	});

	it("reads mutations from TOOL_EXECUTION_END and inherits the tool call id", () => {
		const changes = fileChangesFromToolEnd({
			tool_call_id: "call_1",
			tool_name: "_write",
			file_mutations: [{ path: "src/a.ts", operation: "create", diff: "@@ -0,0 +1 @@\n+a" }],
		});
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			path: "src/a.ts",
			operation: "create",
			toolCallId: "call_1",
			toolName: "_write",
			additions: 1,
			deletions: 0,
		});
	});

	it("supports the legacy nested mutation payload", () => {
		const change = fileChangeFromMutationEvent({
			mutation: { path: "src/old.ts", operation: "modify" },
			tool_call_id: "call_2",
		});
		expect(change).toMatchObject({ path: "src/old.ts", operation: "modify", toolCallId: "call_2" });
	});

	it("dedupes the same mutation arriving from both event paths", () => {
		const fromTool = fileChangesFromToolEnd({
			tool_call_id: "call_1",
			tool_name: "edit",
			file_mutations: [{ path: "src/a.ts", operation: "modify", diff: "-a\n+b" }],
		});
		const fromEvent = fileChangeFromMutationEvent({
			path: "src/a.ts",
			operation: "modify",
			diff: "-a\n+b",
			tool_call_id: "call_1",
			tool_name: "edit",
		});
		expect(fromEvent).not.toBeNull();
		const merged = mergeFileChanges(fromTool, [fromEvent!]);
		expect(merged).toHaveLength(1);
	});

	it("keeps separate edits to the same file when the diffs differ", () => {
		const a = parseFileChange({ path: "src/a.ts", operation: "modify", diff: "+one" }, "call_1");
		const b = parseFileChange({ path: "src/a.ts", operation: "modify", diff: "+two" }, "call_2");
		expect(mergeFileChanges([a!], [b!])).toHaveLength(2);
	});

	it("returns zero stats for an empty diff", () => {
		expect(countDiffStats(undefined)).toEqual({ additions: 0, deletions: 0 });
	});

	it("counts hunk content that begins with +++ or ---", () => {
		const diff = "--- a/a.c\n+++ b/a.c\n@@ -1,2 +1,2 @@\n+++i;\n---j;\n context";
		expect(countDiffStats(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("leaves stats unknown for the real runtime payload without a diff", () => {
		const changes = fileChangesFromToolEnd({
			tool_call_id: "call_real",
			tool_name: "cli",
			file_mutations: [{ path: "src/real.ts", operation: "modify" }],
		});
		expect(changes).toHaveLength(1);
		expect(changes[0].additions).toBeUndefined();
		expect(changes[0].deletions).toBeUndefined();
		expect(changes[0].diff).toBeUndefined();
	});

	it("merges a path-only tool-end mutation with its diff-bearing applied event", () => {
		const fromTool = fileChangesFromToolEnd({
			tool_call_id: "call_edit",
			tool_name: "cli",
			file_mutations: [{ path: "src/edit.ts", operation: "modify" }],
		});
		const fromEvent = fileChangeFromMutationEvent({
			path: "src/edit.ts",
			operation: "modify",
			diff: "@@ -1 +1 @@\n-a\n+b",
			tool_call_id: "call_edit",
		});
		expect(fromEvent).not.toBeNull();
		const merged = mergeFileChanges(fromTool, [fromEvent!]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ additions: 1, deletions: 1, diff: fromEvent!.diff });
	});

	it("filters historical mutations to the active thread", () => {
		const events = [
			{ thread_id: "thread_a", payload: { path: "src/a.ts", operation: "modify", tool_call_id: "a" } },
			{ thread_id: "thread_b", payload: { path: "src/leak.ts", operation: "modify", tool_call_id: "b" } },
		];
		const changes = fileChangesForThread(events, "thread_a");
		expect(changes).toHaveLength(1);
		expect(changes[0].path).toBe("src/a.ts");
	});
});
