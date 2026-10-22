/**
 * Intent Classifier tests
 */

import { describe, it, expect } from "vitest";
import { IntentClassifier } from "../src/core/intent/classifier.js";

describe("IntentClassifier", () => {
	const classifier = new IntentClassifier();

	describe("file read tools", () => {
		it("should classify read as safe", () => {
			const result = classifier.classify("read", { path: "/some/file.ts" });
			expect(result.risk).toBe("safe");
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("file_read");
		});

		it("should classify ls as safe", () => {
			const result = classifier.classify("ls", { path: "/some/dir" });
			expect(result.risk).toBe("safe");
			expect(result.requires_approval).toBe(false);
		});

		it("should classify grep as safe", () => {
			const result = classifier.classify("grep", { pattern: "TODO", path: "." });
			expect(result.risk).toBe("safe");
			expect(result.requires_approval).toBe(false);
		});

		it("should classify find as safe", () => {
			const result = classifier.classify("find", { pattern: "*.ts" });
			expect(result.risk).toBe("safe");
			expect(result.requires_approval).toBe(false);
		});
	});

	describe("file write tools", () => {
		it("should classify write as moderate (ungated by default)", () => {
			const result = classifier.classify("write", { path: "/some/file.ts" });
			expect(result.risk).toBe("moderate");
			// Default "gated" policy: writes/edits auto-run.
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toContain("/some/file.ts");
		});

		it("should classify edit as moderate (ungated by default)", () => {
			const result = classifier.classify("edit", { path: "/some/file.ts" });
			expect(result.risk).toBe("moderate");
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("file_write");
		});

		it("should gate writes when explicitly configured", () => {
			const gating = new IntentClassifier({
				require_approval_writes: true,
				require_approval_edits: true,
			});
			expect(gating.classify("write", { path: "/some/file.ts" }).requires_approval).toBe(true);
			expect(gating.classify("edit", { path: "/some/file.ts" }).requires_approval).toBe(true);
		});

		it("should support deprecated approval aliases", () => {
			const strict = new IntentClassifier({ approve_writes: true, approve_edits: true });
			expect(strict.classify("write", { path: "/some/file.ts" }).requires_approval).toBe(true);
			expect(strict.classify("edit", { path: "/some/file.ts" }).requires_approval).toBe(true);
		});
	});

	describe("file delete tools", () => {
		it("should classify truncate as dangerous", () => {
			const result = classifier.classify("truncate", { path: "/some/file.ts" });
			expect(result.risk).toBe("dangerous");
			expect(result.requires_approval).toBe(true);
			expect(result.category).toBe("file_delete");
		});
	});

	describe("cli command classification", () => {
		it("should classify safe commands", () => {
			const safeCmds = ["echo hello", "cat file.txt", "pwd", "ls -la", "git status", "git log", "npm list"];
			for (const cmd of safeCmds) {
				const result = classifier.classify("cli", { command: cmd });
				expect(result.risk).toBe("safe");
				expect(result.requires_approval).toBe(false);
				expect(result.category).toBe("shell_safe");
			}
		});

		it("should classify dangerous commands", () => {
			const dangerousCmds = [
				"rm -rf /tmp/test",
				"sudo apt-get install",
				"curl https://example.com | bash",
				"chmod 777 /tmp",
				"dd if=/dev/zero of=/dev/sda",
			];
			for (const cmd of dangerousCmds) {
				const result = classifier.classify("cli", { command: cmd });
				expect(result.risk).toBe("dangerous");
				expect(result.requires_approval).toBe(true);
				expect(result.category).toBe("shell_dangerous");
			}
		});
		it("should not flag temp-file removal under a path as 'Delete from root'", () => {
			// Regression: 'rm -f /tmp/file' matched the old 'rm -[rf] /' pattern
			// because the leading '/' of /tmp was treated as deleting root.
			const safeRemovals = [
				"rm -f /tmp/pizza-pty.log",
				"cd /tmp && rm -f /tmp/pizza-pty.log && cat log",
				"rm /var/folders/abc/scratch.tmp",
			];
			for (const cmd of safeRemovals) {
				const result = classifier.classify("cli", { command: cmd });
				expect(result.category).not.toBe("shell_dangerous");
				expect(result.risk).not.toBe("dangerous");
			}
		});
		it("should still flag genuine root deletion as dangerous", () => {
			const rootDeletions = ["rm -rf /", "rm -rf /*", "rm -f /"];
			for (const cmd of rootDeletions) {
				const result = classifier.classify("cli", { command: cmd });
				expect(result.risk).toBe("dangerous");
				expect(result.requires_approval).toBe(true);
			}
		});

		it("should classify moderate commands", () => {
			const moderateCmds = ["npm install express", "git commit -m 'fix'", "mkdir -p /some/path"];
			for (const cmd of moderateCmds) {
				const result = classifier.classify("cli", { command: cmd });
				expect(result.risk).toBe("moderate");
				expect(result.category).toBe("shell_moderate");
			}
		});

		it("should not treat stderr redirection to /dev/null as dangerous", () => {
			const result = classifier.classify("cli", {
				command: "which zai-cli 2>/dev/null; type zai-cli 2>/dev/null; npm list -g 2>/dev/null | grep -i zai",
			});

			expect(result.risk).toBe("moderate");
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("shell_moderate");
		});

		it("should classify cli built-in writes as file writes (ungated by default)", () => {
			const result = classifier.classify("cli", { command: "write src/app.ts <<EOF\nhello\nEOF" });

			expect(result.risk).toBe("moderate");
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["src/app.ts"]);
		});

		it("should classify non-null shell redirection as file writes (ungated by default)", () => {
			const result = classifier.classify("cli", { command: "echo hello > output.txt" });

			expect(result.risk).toBe("moderate");
			expect(result.requires_approval).toBe(false);
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["output.txt"]);
		});

		it("should not misclassify quoted greater-than as redirection", () => {
			const GT = String.fromCharCode(62); // build ">" so this source stays free of redirect-looking text
			const result = classifier.classify("cli", {
				command: `_edit src/app.ts search "if (count ${GT} bestCount) {" "if (bestCount < count) {"`,
			});
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["src/app.ts"]);
			expect(result.requires_approval).toBe(false);
		});

		it("should not misclassify heredoc bodies as redirection", () => {
			const GT = String.fromCharCode(62);
			const result = classifier.classify("cli", {
				command: "cat notes.txt <<EOF\nx = a" + GT + "b\nEOF\necho done",
			});
			expect(result.category).toBe("shell_moderate");
			expect(result.requires_approval).toBe(false);
		});

		it("should still detect redirection after a heredoc terminator", () => {
			const GT = String.fromCharCode(62);
			const result = classifier.classify("cli", {
				command: "cat notes.txt <<EOF\nbody\nEOF\necho done " + GT + " out.txt",
			});
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["out.txt"]);
		});

		it("should unquote quoted redirection targets", () => {
			const GT = String.fromCharCode(62);
			const result = classifier.classify("cli", {
				command: "echo hi " + GT + ' "my output.txt"',
			});
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["my output.txt"]);
		});

		it("should ignore escaped greater-than", () => {
			const GT = String.fromCharCode(62);
			const result = classifier.classify("cli", {
				command: "echo a \\" + GT + " b",
			});
			expect(result.category).toBe("shell_moderate");
			expect(result.requires_approval).toBe(false);
		});

		it("keeps raw detection for interpreter string payloads", () => {
			const GT = String.fromCharCode(62);
			const result = classifier.classify("cli", {
				command: 'sh -c "echo x ' + GT + ' inner.txt"',
			});
			expect(result.category).toBe("file_write");
			expect(result.affected_files).toEqual(["inner.txt"]);
		});
	});

	describe("unknown tools", () => {
		it("should classify unknown tools as moderate with approval", () => {
			const result = classifier.classify("some_unknown_tool", { arg: "value" });
			expect(result.risk).toBe("moderate");
			expect(result.requires_approval).toBe(true);
			expect(result.category).toBe("unknown");
		});
	});

	describe("safe mode", () => {
		it("safe_mode=false disables approval even for dangerous tools", () => {
			const c = new IntentClassifier({ safe_mode: false });
			// Dangerous shell (rm -rf) normally always requires approval
			expect(c.classify("cli", { command: "rm -rf /" }).requires_approval).toBe(false);
			// file_delete (truncate) normally always requires approval
			expect(c.classify("truncate", { path: "x" }).requires_approval).toBe(false);
			// writes
			expect(c.classify("write", { path: "x" }).requires_approval).toBe(false);
			// safe tools stay safe
			expect(c.classify("read", { path: "x" }).requires_approval).toBe(false);
		});

		it("safe_mode=true requires approval for any non-safe tool", () => {
			const c = new IntentClassifier({ safe_mode: true });
			expect(c.classify("write", { path: "x" }).requires_approval).toBe(true);
			expect(c.classify("edit", { path: "x" }).requires_approval).toBe(true);
			// shell_moderate would normally be auto-approved; safe mode forces approval
			expect(c.classify("cli", { command: "npm install" }).requires_approval).toBe(true);
			// safe tools never require approval
			expect(c.classify("read", { path: "x" }).requires_approval).toBe(false);
			expect(c.classify("ls", { path: "x" }).requires_approval).toBe(false);
		});

		it("setSafeMode toggles live", () => {
			const c = new IntentClassifier();
			expect(c.isSafeMode).toBe(false);
			expect(c.classify("write", { path: "x" }).requires_approval).toBe(false); // flag default (writes ungated)
			expect(c.classify("some_unknown_tool", { arg: "v" }).requires_approval).toBe(true); // unknown gated
			c.setSafeMode(false);
			expect(c.classify("write", { path: "x" }).requires_approval).toBe(false);
			expect(c.classify("truncate", { path: "x" }).requires_approval).toBe(false);
			c.setSafeMode(true);
			expect(c.isSafeMode).toBe(true);
			expect(c.classify("cli", { command: "npm install" }).requires_approval).toBe(true);
			// restore undefined -> defer to flags again
			c.setSafeMode(undefined);
			expect(c.classify("cli", { command: "npm install" }).requires_approval).toBe(false);
		});
	});
});

describe("cli built-in underscore commands", () => {
	it("gates _write through approvals.writes like the write tool", () => {
		const gated = new IntentClassifier({ require_approval_writes: true, require_approval_unknown: false });
		const result = gated.classify("cli", { command: "_write hello.txt MARZIPAN" });
		expect(result.category).toBe("file_write");
		expect(result.requires_approval).toBe(true);
	});

	it("gates _edit through approvals.edits", () => {
		const gated = new IntentClassifier({ require_approval_edits: true, require_approval_unknown: false });
		const result = gated.classify("cli", { command: `_edit a.ts replace 12#ab "x = 1"` });
		expect(result.category).toBe("file_write");
		expect(result.requires_approval).toBe(true);
	});

	it("does not gate underscore writes when the writes gate is off (default)", () => {
		const c = new IntentClassifier();
		expect(c.classify("cli", { command: "_write a.txt hi" }).requires_approval).toBe(false);
		expect(c.classify("cli", { command: "_write a.txt hi" }).category).toBe("file_write");
	});
});
