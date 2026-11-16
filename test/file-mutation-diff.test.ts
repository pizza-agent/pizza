import { describe, expect, it } from "vitest";
import { fileMutationDiff } from "../src/core/runtime/file-mutation-diff";

describe("fileMutationDiff", () => {
	it("extracts an _edit diff from the CLI command details", () => {
		const details = {
			command: {
				source: "builtin",
				name: "_edit",
				args: { path: "src/edit.ts" },
				details: { diff: "@@ -1 +1 @@\n-a\n+b", firstChangedLine: 1 },
			},
		};
		expect(fileMutationDiff(details, "src/edit.ts")).toBe("@@ -1 +1 @@\n-a\n+b");
	});

	it("does not attach a diff to a different path", () => {
		const details = { command: { args: { path: "src/other.ts" }, details: { diff: "@@ -1 +1 @@\n-a\n+b" } } };
		expect(fileMutationDiff(details, "src/edit.ts")).toBeUndefined();
	});

	it("returns undefined for writes and malformed details", () => {
		expect(fileMutationDiff(undefined, "src/a.ts")).toBeUndefined();
		expect(fileMutationDiff({}, "src/a.ts")).toBeUndefined();
		expect(fileMutationDiff({ command: { args: { path: "src/a.ts" } } }, "src/a.ts")).toBeUndefined();
	});
});
