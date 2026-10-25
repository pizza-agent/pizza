#!/usr/bin/env node

/**
 * Build the self-contained Pizza remote server package.
 *
 * The archive is extracted as-is on the remote host and run with a private
 * Node runtime, so it ships everything needed at runtime:
 *   - an explicit whitelist of the Node build in dist/ (no Bun-binary layout,
 *     no Windows-only assets, no stale build leftovers)
 *   - production node_modules resolved from package-lock.json, pruned of
 *     Windows binaries, type declarations and source maps
 *   - node-pty native builds for macOS (upstream prebuilds) and Linux (built
 *     once in Docker and cached in .vendor-tools/)
 *
 * The remote host never runs npm, so installs are deterministic and need no
 * registry access or build toolchain.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Node.js runtime installed on remote hosts. Single source of truth: the
 *  desktop reads it (and its checksums) from the generated manifest. */
const NODE_RUNTIME_VERSION = "22.23.1";
const NODE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const LINUX_PTY_TARGETS = { "linux-x64": "linux/amd64", "linux-arm64": "linux/arm64" };
const MANIFEST_SCHEMA_VERSION = 2;

const root = process.cwd();
const dist = join(root, "dist");
const cacheRoot = join(root, ".vendor-tools");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const outputDir = join(dist, "remote");

/** Paths under dist/ needed by the Node CLI layout (see src/config.ts). */
const DIST_WHITELIST = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"providers.json",
	"src",
	"packages",
	"docs",
	"examples",
	...NODE_TARGETS.map((target) => `vendor/bin/${target}`),
];

function log(message) {
	console.log(`[build-remote-server] ${message}`);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(dir, visit) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (visit(full, entry) === false) continue;
		if (entry.isDirectory()) walk(full, visit);
	}
}

function dirSize(dir) {
	let total = 0;
	walk(dir, (full, entry) => {
		if (entry.isFile()) total += statSync(full).size;
	});
	return total;
}

function runtimePackageJson() {
	const {
		scripts: _scripts,
		devDependencies: _devDependencies,
		overrides: _overrides,
		...runtime
	} = packageJson;
	return `${JSON.stringify(runtime, null, "\t")}\n`;
}

/** Pinned Node runtime checksums, fetched once per version and cached. */
async function nodeRuntimeChecksums() {
	const cachePath = join(cacheRoot, `node-v${NODE_RUNTIME_VERSION}-SHASUMS256.txt`);
	let text;
	if (existsSync(cachePath)) {
		text = readFileSync(cachePath, "utf8");
	} else {
		const url = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/SHASUMS256.txt`;
		log(`fetching ${url}`);
		const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
		text = await response.text();
		mkdirSync(cacheRoot, { recursive: true });
		writeFileSync(cachePath, text);
	}
	const checksums = {};
	for (const target of NODE_TARGETS) {
		const name = `node-v${NODE_RUNTIME_VERSION}-${target}.tar.gz`;
		const line = text.split("\n").find((entry) => entry.trim().endsWith(`  ${name}`));
		const sha = line?.trim().split(/\s+/)[0];
		if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new Error(`No checksum for ${name}`);
		checksums[target] = sha;
	}
	return checksums;
}

function dockerAvailable() {
	const result = spawnSync("docker", ["info"], { stdio: "ignore" });
	return result.status === 0;
}

/**
 * node-pty publishes no Linux prebuilds. Build pty.node per arch inside a
 * Debian bullseye container (glibc 2.31, below Node 22's own baseline) and
 * cache it. node-pty uses N-API, so one build serves every Node 22 runtime.
 */
function ensureLinuxPtyBuild(ptyVersion, target) {
	const cacheDir = join(cacheRoot, `node-pty-${ptyVersion}`, target);
	const cached = join(cacheDir, "pty.node");
	if (existsSync(cached)) return cached;
	if (!dockerAvailable()) return null;
	mkdirSync(cacheDir, { recursive: true });
	log(`building node-pty ${ptyVersion} for ${target} in Docker (cached afterwards)`);
	const script = [
		"set -e",
		"mkdir -p /work && cd /work",
		"npm init -y >/dev/null",
		`npm install --no-audit --no-fund --loglevel=error node-pty@${ptyVersion}`,
		"cp node_modules/node-pty/build/Release/pty.node /out/pty.node",
	].join(" && ");
	const result = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--platform",
			LINUX_PTY_TARGETS[target],
			"-v",
			`${cacheDir}:/out`,
			`node:${NODE_RUNTIME_VERSION.split(".")[0]}-bullseye`,
			"bash",
			"-c",
			script,
		],
		{ stdio: "inherit" },
	);
	if (result.status !== 0 || !existsSync(cached)) {
		rmSync(cacheDir, { recursive: true, force: true });
		throw new Error(`Docker build of node-pty for ${target} failed`);
	}
	return cached;
}

function pruneNodeModules(nodeModules) {
	const ptyDir = join(nodeModules, "node-pty");
	if (existsSync(ptyDir)) {
		for (const entry of ["deps", "src", "third_party", "scripts", "binding.gyp", "typings", "build"]) {
			rmSync(join(ptyDir, entry), { recursive: true, force: true });
		}
	}
	walk(nodeModules, (full, entry) => {
		if (entry.isDirectory() && /^win32-(x64|arm64|ia32)$/.test(entry.name)) {
			rmSync(full, { recursive: true, force: true });
			return false;
		}
		if (entry.isFile() && /(\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.pdb)$/.test(entry.name)) {
			rmSync(full, { force: true });
		}
		return true;
	});
}

function addLinuxPtyBuilds(nodeModules) {
	const ptyDir = join(nodeModules, "node-pty");
	if (!existsSync(ptyDir)) return;
	const ptyVersion = JSON.parse(readFileSync(join(ptyDir, "package.json"), "utf8")).version;
	for (const target of Object.keys(LINUX_PTY_TARGETS)) {
		const built = ensureLinuxPtyBuild(ptyVersion, target);
		if (!built) {
			const message = `node-pty Linux build for ${target} unavailable (Docker not running); the remote Terminal pane will be disabled on ${target}`;
			if (process.env.PIZZA_REQUIRE_LINUX_PTY === "1") throw new Error(message);
			console.warn(`[build-remote-server] WARNING ${message}`);
			continue;
		}
		const targetDir = join(ptyDir, "prebuilds", target);
		mkdirSync(targetDir, { recursive: true });
		copyFileSync(built, join(targetDir, "pty.node"));
	}
	for (const target of ["darwin-x64", "darwin-arm64"]) {
		const helper = join(ptyDir, "prebuilds", target, "spawn-helper");
		if (existsSync(helper)) chmodSync(helper, 0o755);
	}
}

async function main() {
	if (!existsSync(join(dist, "src", "cli.js"))) {
		throw new Error("dist/src/cli.js is missing; run the normal build first");
	}
	const nodeChecksums = await nodeRuntimeChecksums();

	const stagingRoot = mkdtempSync(join(tmpdir(), "pizza-remote-package-"));
	const pkgRoot = join(stagingRoot, "package");
	try {
		mkdirSync(join(pkgRoot, "dist"), { recursive: true });
		writeFileSync(join(pkgRoot, "package.json"), runtimePackageJson());
		copyFileSync(join(root, "package-lock.json"), join(pkgRoot, "package-lock.json"));
		if (existsSync(join(root, "README.md"))) copyFileSync(join(root, "README.md"), join(pkgRoot, "README.md"));

		for (const relative of DIST_WHITELIST) {
			const source = join(dist, relative);
			if (!existsSync(source)) continue;
			cpSync(source, join(pkgRoot, "dist", relative), { recursive: true });
		}

		log("installing production dependencies from package-lock.json");
		execFileSync(
			"npm",
			["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
			{ cwd: pkgRoot, stdio: "inherit" },
		);
		const nodeModules = join(pkgRoot, "node_modules");
		pruneNodeModules(nodeModules);
		addLinuxPtyBuilds(nodeModules);
		log(`node_modules: ${(dirSize(nodeModules) / 1024 / 1024).toFixed(1)} MB`);

		mkdirSync(outputDir, { recursive: true });
		for (const entry of readdirSync(outputDir)) {
			if (/^pizza-server-.+\.tgz$/.test(entry)) rmSync(join(outputDir, entry), { force: true });
		}
		const outputName = `pizza-server-${version}.tgz`;
		const outputPath = join(outputDir, outputName);
		// System tar (not npm pack) keeps node_modules and file modes.
		// COPYFILE_DISABLE stops macOS bsdtar from adding AppleDouble files.
		execFileSync("tar", ["--no-xattrs", "-czf", outputPath, "-C", stagingRoot, "package"], {
			stdio: "inherit",
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});

		const sizeBytes = statSync(outputPath).size;
		const sha256 = sha256File(outputPath);
		writeFileSync(
			join(outputDir, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: MANIFEST_SCHEMA_VERSION,
					version,
					archive: outputName,
					sizeBytes,
					sha256,
					nodeRuntime: {
						version: NODE_RUNTIME_VERSION,
						sha256: nodeChecksums,
					},
				},
				null,
				2,
			)}\n`,
		);
		log(`wrote ${outputPath}`);
		log(`sha256=${sha256} size=${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
