#!/usr/bin/env node

/**
 * Build the tauri-plugin-updater manifest (`latest.json`) for a desktop release
 * from the renamed, signed bundles produced by the desktop release workflow.
 *
 * Usage:
 *   node scripts/generate-updater-manifest.mjs <artifacts-dir> <tag> <out-file>
 *
 * Every bundle that has a sibling `.sig` becomes a platform entry pointing at
 * the GitHub release asset. Keys follow the updater's `{os}-{arch}[-{bundle}]`
 * lookup; the bare `{os}-{arch}` key is the fallback for older bundle types.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";

const [artifactsDir, tag, outFile] = process.argv.slice(2);
if (!artifactsDir || !tag || !outFile) {
	console.error("usage: generate-updater-manifest.mjs <artifacts-dir> <tag> <out-file>");
	process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || "pizza-agent/pizza";
const version = tag.replace(/^v/, "");

/** [filename regex, manifest keys] — first key wins when several bundles match. */
const RULES = [
	[/_macos_arm64\.app\.tar\.gz$/, ["darwin-aarch64-app", "darwin-aarch64"]],
	[/_macos_x64\.app\.tar\.gz$/, ["darwin-x86_64-app", "darwin-x86_64"]],
	[/_windows_x64-setup\.exe$/, ["windows-x86_64-nsis", "windows-x86_64"]],
	[/_windows_x64(_[^.]+)?\.msi$/, ["windows-x86_64-msi"]],
	[/_linux_x64\.AppImage$/, ["linux-x86_64-appimage", "linux-x86_64"]],
	[/_linux_x64\.deb$/, ["linux-x86_64-deb"]],
	[/_linux_x64\.rpm$/, ["linux-x86_64-rpm"]],
];

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

const files = walk(artifactsDir);
const platforms = {};
for (const sigPath of files.filter((f) => f.endsWith(".sig"))) {
	const bundle = basename(sigPath.slice(0, -".sig".length));
	const rule = RULES.find(([re]) => re.test(bundle));
	if (!rule) continue;
	const entry = {
		signature: readFileSync(sigPath, "utf8").trim(),
		url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(bundle)}`,
	};
	for (const key of rule[1]) platforms[key] ??= entry;
}

if (Object.keys(platforms).length === 0) {
	console.error(`no signed updater bundles found under ${artifactsDir}`);
	process.exit(1);
}

const manifest = {
	version,
	notes: `https://github.com/${repo}/releases/tag/${tag}`,
	pub_date: new Date().toISOString(),
	platforms,
};
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${outFile} with platforms: ${Object.keys(platforms).join(", ")}`);
