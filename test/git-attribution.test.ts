import { describe, expect, it } from "vitest";
import {
	annotateGitCommits,
	PIZZA_CO_AUTHOR_TRAILER,
} from "../src/core/git-attribution.js";

const T = ` --trailer '${PIZZA_CO_AUTHOR_TRAILER}'`;

describe("annotateGitCommits", () => {
	it("appends the trailer to a plain git commit", () => {
		expect(annotateGitCommits('git commit -m "fix"')).toBe(`git commit -m "fix"${T}`);
	});

	it("annotates every git commit in a chained command", () => {
		expect(annotateGitCommits('git add a && git commit -m "fix" && git push')).toBe(
			`git add a && git commit -m "fix"${T} && git push`,
		);
	});

	it("handles || and ; chains, keeping separators", () => {
		expect(annotateGitCommits('git commit -m x;   ')).toBe(`git commit -m x${T};   `);
		expect(annotateGitCommits('git commit -m x || echo failed')).toBe(
			`git commit -m x${T} || echo failed`,
		);
	});

	it("inserts before a pipe so the commit output still streams", () => {
		expect(annotateGitCommits("git commit -m x | less")).toBe(`git commit -m x${T} | less`);
	});

	it("handles git global options and env prefixes", () => {
		expect(annotateGitCommits("git -C repo commit -m x")).toBe(`git -C repo commit -m x${T}`);
		expect(annotateGitCommits("git --git-dir=.git commit -m x")).toBe(
			`git --git-dir=.git commit -m x${T}`,
		);
		expect(annotateGitCommits("FOO=1 git commit -m x")).toBe(`FOO=1 git commit -m x${T}`);
		expect(annotateGitCommits("env FOO=1 git commit -m x")).toBe(`env FOO=1 git commit -m x${T}`);
		expect(annotateGitCommits("command git commit -m x")).toBe(`command git commit -m x${T}`);
	});

	it("leaves quoted > and < alone", () => {
		expect(annotateGitCommits('git commit -m "a > b"')).toBe(`git commit -m "a > b"${T}`);
	});

	it("skips commands that already carry a co-authored-by trailer", () => {
		const cmd = 'git commit -m "x" -m "Co-authored-by: some"';
		expect(annotateGitCommits(cmd)).toBe(cmd);
		expect(annotateGitCommits(`git commit --trailer 'Co-Authored-By: X <x@y>'`)).toBe(
			`git commit --trailer 'Co-Authored-By: X <x@y>'`,
		);
	});

	it("skips --dry-run commits", () => {
		const cmd = "git commit -m x --dry-run";
		expect(annotateGitCommits(cmd)).toBe(cmd);
	});

	it("skips a segment ending in a redirect operator (--trailer would become the filename)", () => {
		const cmd = "git commit -m x >";
		expect(annotateGitCommits(cmd)).toBe(cmd);
	});

	it("tolerates mid-command redirections (POSIX allows args after redirects)", () => {
		expect(annotateGitCommits("git commit -m x > out.txt")).toBe(`git commit -m x > out.txt${T}`);
		expect(annotateGitCommits("git commit -m x 2>&1 | tail -3")).toBe(
			`git commit -m x 2>&1${T} | tail -3`,
		);
	});

	it("splits on a bare & background operator", () => {
		expect(annotateGitCommits("git commit -m x & disown")).toBe(`git commit -m x${T} & disown`);
	});

	it("skips `--` pathspec separators where --trailer would be a path", () => {
		const cmd = "git commit -- file.txt";
		expect(annotateGitCommits(cmd)).toBe(cmd);
	});

	it("annotates mixed pathspec commits without `--`", () => {
		expect(annotateGitCommits("git commit file.txt -m x")).toBe(`git commit file.txt -m x${T}`);
		expect(annotateGitCommits("git commit --amend -m x")).toBe(`git commit --amend -m x${T}`);
	});

	it("skips git commit inside command substitution (context is ambiguous)", () => {
		const cmd = "x=$(git commit -m a | cat) && echo hi";
		expect(annotateGitCommits(cmd)).toBe(cmd);
		// Single-piece substitution: appending at the piece end would inject
		// outside the $(...) and corrupt the command.
		expect(annotateGitCommits("x=$( git commit -m a )")).toBe("x=$( git commit -m a )");
	});

	it("still annotates quoted $(...) inside -m messages", () => {
		expect(annotateGitCommits('git commit -m "$(date +%F)"')).toBe(
			`git commit -m "$(date +%F)"${T}`,
		);
	});

	it("skips subshell commands where the commit is not a segment head", () => {
		const cmd = "(git commit -m s) && echo ok";
		expect(annotateGitCommits(cmd)).toBe(cmd);
	});

	it("does not touch non-commit git commands or echoes", () => {
		expect(annotateGitCommits("echo git commit -m x")).toBe("echo git commit -m x");
		expect(annotateGitCommits("git status")).toBe("git status");
		expect(annotateGitCommits("git commit-tree abc -m x")).toBe("git commit-tree abc -m x");
		expect(annotateGitCommits('ssh host "git commit -m x"')).toBe('ssh host "git commit -m x"');
	});

	it("handles multiline commands", () => {
		const cmd = 'git add .\ngit commit -m "msg"';
		expect(annotateGitCommits(cmd)).toBe(`git add .\ngit commit -m "msg"${T}`);
	});
});
