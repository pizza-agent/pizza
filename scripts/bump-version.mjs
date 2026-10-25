#!/usr/bin/env node

/**
 * Bump version across all project files.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.2.0       # set specific version
 *   node scripts/bump-version.mjs patch        # 0.1.8 → 0.1.9
 *   node scripts/bump-version.mjs minor        # 0.1.8 → 0.2.0
 *   node scripts/bump-version.mjs major        # 0.1.8 → 1.0.0
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const files = {
	"package.json": (content, version) => {
		const json = JSON.parse(content);
		const old = json.version;
		json.version = version;
		return { result: JSON.stringify(json, null, "\t") + "\n", old };
	},
	"package-lock.json": (content, version) => {
		const json = JSON.parse(content);
		const old = json.version;
		json.version = version;
		if (json.packages?.[""]?.version) {
			json.packages[""].version = version;
		}
		return { result: JSON.stringify(json, null, "\t") + "\n", old };
	},
	"dist/package.json": (content, version) => {
		const json = JSON.parse(content);
		const old = json.version;
		json.version = version;
		return { result: JSON.stringify(json, null, "\t") + "\n", old };
	},
	"apps/desktop/tauri.conf.json": (content, version) => {
		const json = JSON.parse(content);
		const old = json.version;
		json.version = version;
		return { result: JSON.stringify(json, null, "\t") + "\n", old };
	},
	"apps/desktop/Cargo.toml": (content, version) => {
		const old = content.match(/^version = "([^"]+)"/m)?.[1];
		return { result: content.replace(/^(version = )"[^"]*"/m, `$1"${version}"`), old };
	},
	"apps/desktop/Cargo.lock": (content, version) => {
		// Only update the pizza-gui package entry, not other crates that happen to share the version
		const regex = /(\[\[package\]\]\nname = "pizza-gui"\nversion = )"([^"]+)"/;
		const match = content.match(regex);
		const old = match?.[2];
		return { result: content.replace(regex, `$1"${version}"`), old };
	},
	"apps/web/package.json": (content, version) => {
		const json = JSON.parse(content);
		const old = json.version;
		json.version = version;
		return { result: JSON.stringify(json, null, "\t") + "\n", old };
	},
};

function getCurrentVersion() {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
	return pkg.version;
}

function bumpVersion(current, type) {
	const parts = current.split(".").map(Number);
	if (parts.length !== 3 || parts.some(isNaN)) {
		console.error(`Invalid current version: ${current}`);
		process.exit(1);
	}
	switch (type) {
		case "patch":
			parts[2]++;
			break;
		case "minor":
			parts[1]++;
			parts[2] = 0;
			break;
		case "major":
			parts[0]++;
			parts[1] = 0;
			parts[2] = 0;
			break;
		default:
			console.error(`Unknown bump type: ${type}. Use patch, minor, or major.`);
			process.exit(1);
	}
	return parts.join(".");
}

const arg = process.argv[2];
if (!arg) {
	console.error("Usage: node scripts/bump-version.mjs <version|patch|minor|major>");
	process.exit(1);
}

const current = getCurrentVersion();
const newVersion = ["patch", "minor", "major"].includes(arg)
	? bumpVersion(current, arg)
	: arg;

if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
	console.error(`Invalid version format: ${newVersion}`);
	process.exit(1);
}

console.log(`Bumping version: ${current} → ${newVersion}\n`);

let changed = 0;
let skipped = 0;

for (const [relPath, transform] of Object.entries(files)) {
	const absPath = join(root, relPath);
	if (!existsSync(absPath)) {
		console.log(`  SKIP  ${relPath} (not found)`);
		skipped++;
		continue;
	}
	const content = readFileSync(absPath, "utf-8");
	const { result, old } = transform(content, newVersion);
	if (old === newVersion) {
		console.log(`  SKIP  ${relPath} (already ${newVersion})`);
		skipped++;
		continue;
	}
	writeFileSync(absPath, result, "utf-8");
	console.log(`  OK    ${relPath}  ${old} → ${newVersion}`);
	changed++;
}

console.log(`\nDone: ${changed} files updated, ${skipped} skipped.`);
