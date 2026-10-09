import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThemeFromPath, resolveThemeIcon, resolveThemeVideo } from "../packages/tui/theme/theme.js";

const darkTheme = JSON.parse(readFileSync(join(__dirname, "../packages/tui/theme/dark.json"), "utf-8")) as {
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
};

function writeTheme(dir: string, name: string, extra: Record<string, unknown> = {}): string {
	const themePath = join(dir, `${name}.json`);
	writeFileSync(
		themePath,
		JSON.stringify({ name, vars: darkTheme.vars, colors: darkTheme.colors, ...extra }),
	);
	return themePath;
}

describe("theme web spec", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pizza-theme-web-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("derives web tokens from colors without a web block", () => {
		const theme = loadThemeFromPath(writeTheme(tempRoot, "plain"));
		expect(theme.web?.mode).toBe("dark");
		expect(theme.web?.tokens.accent).toBe("#4ECDC4");
		expect(theme.web?.title).toBeUndefined();
		expect(theme.web?.icon).toBeUndefined();
		expect(theme.web?.css).toBeUndefined();
		expect(theme.web?.video).toBeUndefined();
	});

	it("passes through title, icon, css and video from the web block", () => {
		const themePath = writeTheme(tempRoot, "branded", {
			web: {
				label: "Branded",
				title: "Branded App",
				icon: "icon.svg",
				css: "html { animation: x 1s; }",
				video: "bg.mp4",
				tokens: { bg: "#101020" },
			},
		});
		const theme = loadThemeFromPath(themePath, "truecolor");
		expect(theme.web?.title).toBe("Branded App");
		expect(theme.web?.icon).toBe("icon.svg");
		expect(theme.web?.css).toBe("html { animation: x 1s; }");
		expect(theme.web?.video).toBe("bg.mp4");
		expect(theme.web?.tokens.bg).toBe("#101020");
		// Derived tokens still fill in gaps the explicit block leaves open.
		expect(theme.web?.tokens.accent).toBe("#4ECDC4");
	});

	it("keeps a web spec when the web block has no tokens", () => {
		const themePath = writeTheme(tempRoot, "titleonly", {
			web: { title: "Only Title" },
		});
		const theme = loadThemeFromPath(themePath, "truecolor");
		expect(theme.web?.title).toBe("Only Title");
	});
});

describe("resolveThemeIcon", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pizza-theme-icon-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("passes data: URIs through unchanged", () => {
		const uri = "data:image/png;base64,AAAA";
		expect(resolveThemeIcon(uri, "/anywhere/theme.json")).toBe(uri);
	});

	it("resolves a file path relative to the theme JSON into a data URI", () => {
		const themePath = join(tempRoot, "t.json");
		writeFileSync(join(tempRoot, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
		const resolved = resolveThemeIcon("icon.svg", themePath);
		expect(resolved).toMatch(/^data:image\/svg\+xml;base64,/);
		expect(Buffer.from(resolved!.split(",")[1], "base64").toString()).toContain("<svg");
	});

	it("resolves absolute paths and picks the mime type from the extension", () => {
		const pngPath = join(tempRoot, "icon.png");
		writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		expect(resolveThemeIcon(pngPath, undefined)).toMatch(/^data:image\/png;base64,/);
	});

	it("returns undefined for missing files, http(s) URLs and unknown extensions", () => {
		const themePath = join(tempRoot, "t.json");
		expect(resolveThemeIcon("missing.png", themePath)).toBeUndefined();
		expect(resolveThemeIcon("https://example.com/icon.png", themePath)).toBeUndefined();
		expect(resolveThemeIcon("icon.bmp", themePath)).toBeUndefined();
		expect(resolveThemeIcon(undefined, themePath)).toBeUndefined();
	});
});

describe("resolveThemeVideo", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pizza-theme-video-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("resolves a video file relative to the theme JSON into a data URI", () => {
		const themePath = join(tempRoot, "t.json");
		writeFileSync(join(tempRoot, "bg.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
		const resolved = resolveThemeVideo("bg.webm", themePath);
		expect(resolved).toMatch(/^data:video\/webm;base64,/);
	});

	it("rejects non-video files and remote URLs", () => {
		const themePath = join(tempRoot, "t.json");
		writeFileSync(join(tempRoot, "bg.txt"), "not a video");
		expect(resolveThemeVideo("bg.txt", themePath)).toBeUndefined();
		expect(resolveThemeVideo("https://example.com/bg.mp4", themePath)).toBeUndefined();
		expect(resolveThemeVideo("missing.mp4", themePath)).toBeUndefined();
	});
});
