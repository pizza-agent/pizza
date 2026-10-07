/**
 * Unit tests for the resource path/label formatting helpers extracted out of
 * InteractiveMode. These were previously private methods inside a ~5.8k-line
 * class and had no direct test coverage; the behaviour asserted here is exactly
 * what the class did before the extraction.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	findSourceInfoForPath,
	formatContextPath,
	formatDisplayPath,
	formatPathWithSource,
	getCompactDisplayPathSegments,
	getCompactExtensionLabel,
	getCompactPackageSourceLabel,
	getCompactPathLabel,
	getDisplaySourceInfo,
	getScopeGroup,
	getShortPath,
	isPackageSource,
} from "../packages/tui/resource-path-format.js";
import type { SourceInfo } from "../src/core/source-info.js";

const HOME = "/Users/tester";

function src(overrides: Partial<SourceInfo> = {}): SourceInfo {
	return {
		path: "/tmp/x",
		source: "local",
		scope: "project",
		origin: "top-level",
		...overrides,
	};
}

describe("formatDisplayPath", () => {
	it("abbreviates the home directory", () => {
		expect(formatDisplayPath(`${HOME}/code/app`, HOME)).toBe("~/code/app");
	});

	it("leaves unrelated absolute paths alone", () => {
		expect(formatDisplayPath("/etc/hosts", HOME)).toBe("/etc/hosts");
	});

	it("leaves relative paths alone", () => {
		expect(formatDisplayPath("src/index.ts", HOME)).toBe("src/index.ts");
	});

	it("abbreviates Windows home paths case-insensitively", () => {
		expect(formatDisplayPath("C:\\Users\\Tester\\code\\app", "c:\\users\\tester")).toBe("~/code/app");
	});
});

describe("formatContextPath", () => {
	const cwd = "/Users/tester/project";

	it("renders paths inside the cwd as relative", () => {
		expect(formatContextPath(`${cwd}/src/main.ts`, cwd, HOME)).toBe("src/main.ts");
	});

	it("renders the cwd itself as \".\"", () => {
		expect(formatContextPath(cwd, cwd, HOME)).toBe(".");
	});

	it("falls back to a ~ path when outside the cwd", () => {
		expect(formatContextPath(`${HOME}/other/file.ts`, cwd, HOME)).toBe("~/other/file.ts");
	});

	it("resolves relative input against the cwd", () => {
		expect(formatContextPath("src/main.ts", cwd, HOME)).toBe("src/main.ts");
	});
});

describe("isPackageSource", () => {
	it("recognises npm and git sources", () => {
		expect(isPackageSource(src({ source: "npm:pkg" }))).toBe(true);
		expect(isPackageSource(src({ source: "git:github.com/a/b" }))).toBe(true);
	});

	it("rejects local, cli and missing sources", () => {
		expect(isPackageSource(src({ source: "local" }))).toBe(false);
		expect(isPackageSource(src({ source: "cli" }))).toBe(false);
		expect(isPackageSource(undefined)).toBe(false);
	});
});

describe("getShortPath", () => {
	it("relativises against baseDir for package sources", () => {
		const info = src({ source: "npm:my-pkg", baseDir: "/pkgs/my-pkg" });
		expect(getShortPath("/pkgs/my-pkg/skills/a.md", info, HOME)).toBe("skills/a.md");
	});

	it("ignores baseDir when the path escapes it", () => {
		const info = src({ source: "npm:my-pkg", baseDir: "/pkgs/my-pkg" });
		// Outside baseDir → must not produce a "../" label.
		expect(getShortPath("/elsewhere/a.md", info, HOME)).toBe("/elsewhere/a.md");
	});

	it("ignores baseDir for non-package sources", () => {
		const info = src({ source: "local", baseDir: "/pkgs/my-pkg" });
		expect(getShortPath("/pkgs/my-pkg/skills/a.md", info, HOME)).toBe("/pkgs/my-pkg/skills/a.md");
	});

	it("strips the node_modules prefix for npm sources without baseDir", () => {
		const info = src({ source: "npm:@scope/pkg" });
		expect(getShortPath("/proj/node_modules/@scope/pkg/dist/ext.js", info, HOME)).toBe("dist/ext.js");
	});

	it("strips the git cache prefix for git sources", () => {
		const info = src({ source: "git:github.com/a/b" });
		expect(getShortPath("/cache/git/github.com/repo/extensions/x.js", info, HOME)).toBe("extensions/x.js");
	});

	it("falls back to a ~ path with no source info", () => {
		expect(getShortPath(`${HOME}/.pizza/skills/s.md`, undefined, HOME)).toBe("~/.pizza/skills/s.md");
	});
});

describe("getCompactPathLabel / segments", () => {
	it("returns the final path segment", () => {
		expect(getCompactPathLabel(`${HOME}/.pizza/skills/deep/s.md`, undefined, HOME)).toBe("s.md");
	});

	it("drops the ~ segment when splitting", () => {
		expect(getCompactDisplayPathSegments(`${HOME}/a/b.md`, HOME)).toEqual(["a", "b.md"]);
	});

	it("normalises Windows separators", () => {
		expect(getCompactDisplayPathSegments("C:\\proj\\a\\b.md", HOME)).toEqual(["C:", "proj", "a", "b.md"]);
	});
});

describe("getCompactPackageSourceLabel", () => {
	it("strips the npm: prefix", () => {
		expect(getCompactPackageSourceLabel(src({ source: "npm:my-pkg" }))).toBe("my-pkg");
	});

	it("returns the repo path for a git source", () => {
		const label = getCompactPackageSourceLabel(src({ source: "git:https://github.com/acme/tools.git" }));
		expect(label).toContain("acme/tools");
	});

	it("passes through an unknown source unchanged", () => {
		expect(getCompactPackageSourceLabel(src({ source: "local" }))).toBe("local");
	});

	it("returns empty string when source is absent", () => {
		expect(getCompactPackageSourceLabel(undefined)).toBe("");
	});
});

describe("getCompactExtensionLabel", () => {
	it("collapses an index file to just the package name", () => {
		const info = src({ source: "npm:my-pkg", baseDir: "/pkgs/my-pkg" });
		expect(getCompactExtensionLabel("/pkgs/my-pkg/extensions/index.js", info, HOME)).toBe("my-pkg");
	});

	it("keeps the directory when an index sits in a subdir", () => {
		const info = src({ source: "npm:my-pkg", baseDir: "/pkgs/my-pkg" });
		expect(getCompactExtensionLabel("/pkgs/my-pkg/extensions/sub/index.js", info, HOME)).toBe("my-pkg:sub");
	});

	it("uses package:path for a named extension file", () => {
		const info = src({ source: "npm:my-pkg", baseDir: "/pkgs/my-pkg" });
		expect(getCompactExtensionLabel("/pkgs/my-pkg/extensions/hooks.js", info, HOME)).toBe("my-pkg:hooks.js");
	});

	it("falls back to the plain file label for local extensions", () => {
		const info = src({ source: "local" });
		expect(getCompactExtensionLabel(`${HOME}/.pizza/extensions/mine.js`, info, HOME)).toBe("mine.js");
	});
});

describe("getDisplaySourceInfo", () => {
	it("labels local scopes in muted colour", () => {
		expect(getDisplaySourceInfo(src({ source: "local", scope: "user" }))).toEqual({
			label: "user",
			color: "muted",
		});
		expect(getDisplaySourceInfo(src({ source: "local", scope: "project" }))).toEqual({
			label: "project",
			color: "muted",
		});
	});

	it("marks temporary local sources as a temp path", () => {
		expect(getDisplaySourceInfo(src({ source: "local", scope: "temporary" }))).toEqual({
			label: "path",
			scopeLabel: "temp",
			color: "muted",
		});
	});

	it("labels cli sources as path", () => {
		expect(getDisplaySourceInfo(src({ source: "cli", scope: "project" }))).toEqual({
			label: "path",
			scopeLabel: undefined,
			color: "muted",
		});
	});

	it("highlights package sources with their scope", () => {
		expect(getDisplaySourceInfo(src({ source: "npm:pkg", scope: "user" }))).toEqual({
			label: "npm:pkg",
			scopeLabel: "user",
			color: "accent",
		});
	});

	it("defaults to local/project when no info is given", () => {
		expect(getDisplaySourceInfo(undefined)).toEqual({ label: "project", color: "muted" });
	});
});

describe("getScopeGroup", () => {
	it("buckets by scope", () => {
		expect(getScopeGroup(src({ scope: "user" }))).toBe("user");
		expect(getScopeGroup(src({ scope: "project" }))).toBe("project");
	});

	it("treats cli and temporary as path", () => {
		expect(getScopeGroup(src({ source: "cli", scope: "user" }))).toBe("path");
		expect(getScopeGroup(src({ scope: "temporary" }))).toBe("path");
	});

	it("defaults to project", () => {
		expect(getScopeGroup(undefined)).toBe("project");
	});
});

describe("findSourceInfoForPath", () => {
	it("prefers an exact match", () => {
		const exact = src({ source: "npm:exact" });
		const map = new Map([["/a/b/c.md", exact]]);
		expect(findSourceInfoForPath("/a/b/c.md", map)).toBe(exact);
	});

	it("walks up to the nearest ancestor", () => {
		const parent = src({ source: "npm:parent" });
		const map = new Map([["/a/b", parent]]);
		expect(findSourceInfoForPath("/a/b/deep/c.md", map)).toBe(parent);
	});

	it("prefers the closest ancestor over a more distant one", () => {
		const near = src({ source: "npm:near" });
		const far = src({ source: "npm:far" });
		const map = new Map([
			["/a", far],
			["/a/b", near],
		]);
		expect(findSourceInfoForPath("/a/b/c.md", map)).toBe(near);
	});

	it("returns undefined when nothing matches", () => {
		expect(findSourceInfoForPath("/x/y.md", new Map())).toBeUndefined();
	});
});

describe("formatPathWithSource", () => {
	it("prefixes the provenance label", () => {
		const info = src({ source: "npm:pkg", scope: "user", baseDir: "/pkgs/pkg" });
		expect(formatPathWithSource("/pkgs/pkg/skills/a.md", info, HOME)).toBe("npm:pkg (user) skills/a.md");
	});

	it("omits the parenthetical when there is no scope label", () => {
		const info = src({ source: "local", scope: "project" });
		expect(formatPathWithSource("/proj/a.md", info, HOME)).toBe("project /proj/a.md");
	});

	it("falls back to a plain display path with no source info", () => {
		expect(formatPathWithSource(`${HOME}/a.md`, undefined, HOME)).toBe("~/a.md");
	});
});