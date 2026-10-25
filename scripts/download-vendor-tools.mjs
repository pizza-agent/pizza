#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extractZip from "extract-zip";

const FD_VERSION = "10.4.2";
const FD_DARWIN_X64_VERSION = "10.3.0";
const RG_VERSION = "15.1.0";

const outRoot = fileURLToPath(new URL("../dist/vendor/bin/", import.meta.url));
const cacheRoot = fileURLToPath(new URL("../.vendor-tools/", import.meta.url));

const targets = {
	"darwin-arm64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-apple-darwin.tar.gz`,
			sha256: "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
			binary: "fd",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`,
			sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
			binary: "rg",
		},
	},
	"darwin-x64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_DARWIN_X64_VERSION}/fd-v${FD_DARWIN_X64_VERSION}-x86_64-apple-darwin.tar.gz`,
			sha256: "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
			binary: "fd",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`,
			sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
			binary: "rg",
		},
	},
	"linux-arm64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
			sha256: "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5",
			binary: "fd",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
			sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
			binary: "rg",
		},
	},
	"linux-x64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
			sha256: "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde",
			binary: "fd",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
			sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
			binary: "rg",
		},
	},
	"win32-arm64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
			sha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
			binary: "fd.exe",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-pc-windows-msvc.zip`,
			sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
			binary: "rg.exe",
		},
	},
	"win32-x64": {
		fd: {
			url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,
			sha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
			binary: "fd.exe",
		},
		rg: {
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
			sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
			binary: "rg.exe",
		},
	},
};

function selectedTargets() {
	const value = process.env.PIZZA_VENDOR_TOOL_TARGETS;
	if (!value || value === "all") return Object.keys(targets);
	if (value === "current") return [`${process.platform}-${process.arch}`];
	return value
		.split(",")
		.map((target) => target.trim())
		.filter(Boolean);
}

async function download(url) {
	if (process.env.PIZZA_VENDOR_TOOL_DOWNLOAD === "gh") {
		const ghDownload = await downloadWithGh(url);
		if (ghDownload) return ghDownload;
	}

	let lastError;
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			const response = await fetch(url, {
				headers: {
					"User-Agent": "pizza-vendor-tools",
				},
				redirect: "follow",
				signal: AbortSignal.timeout(120000),
			});
			if (!response.ok) {
				throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
			}
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			lastError = error;
			if (attempt < 4) {
				const delayMs = attempt * 1500;
				console.log(`Download failed, retrying in ${delayMs / 1000}s (${attempt}/4)`);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}
	const ghDownload = await downloadWithGh(url);
	if (ghDownload) return ghDownload;
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadWithGh(url) {
	const parsed = new URL(url);
	const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
	if (!match) return null;

	const [, owner, repo, tag, assetName] = match;
	const tempDir = await mkdtemp(path.join(tmpdir(), "pizza-gh-download-"));
	try {
		console.log("Trying GitHub CLI download fallback");
		const result = spawnSync(
			"gh",
			[
				"release",
				"download",
				decodeURIComponent(tag),
				"--repo",
				`${owner}/${repo}`,
				"--pattern",
				decodeURIComponent(assetName),
				"--dir",
				tempDir,
				"--clobber",
			],
			{ encoding: "utf-8", stdio: "pipe" },
		);
		if (result.error) {
			if ("code" in result.error && result.error.code === "ENOENT") return null;
			throw result.error;
		}
		if (result.status !== 0) {
			return null;
		}
		const outputPath = path.join(tempDir, decodeURIComponent(assetName));
		return await readFile(outputPath);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

async function extractArchive(archivePath, extractDir) {
	await mkdir(extractDir, { recursive: true });
	if (archivePath.endsWith(".zip")) {
		await extractZip(archivePath, { dir: extractDir });
		return;
	}
	if (archivePath.endsWith(".tar.gz")) {
		// Run from the archive's dir with a relative -f: GNU tar parses
		// drive-letter paths (`D:\...`) as remote `host:path` specs.
		const result = spawnSync("tar", ["-xzf", path.basename(archivePath), "-C", extractDir], {
			cwd: path.dirname(archivePath),
			stdio: "inherit",
		});
		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`tar exited with code ${result.status ?? "unknown"}`);
		}
		return;
	}
	throw new Error(`Unsupported archive type: ${archivePath}`);
}

async function findBinary(dir, binaryName) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === binaryName) return fullPath;
		if (entry.isDirectory()) {
			const found = await findBinary(fullPath, binaryName);
			if (found) return found;
		}
	}
	return null;
}

async function installTool(targetName, toolName, asset) {
	const tempDir = await mkdtemp(path.join(tmpdir(), `pizza-${toolName}-${targetName}-`));
	try {
		const archiveName = path.basename(new URL(asset.url).pathname);
		const cacheDir = path.join(cacheRoot, targetName);
		const cachePath = path.join(cacheDir, archiveName);
		const extractDir = path.join(tempDir, "extract");

		let archive;
		if (existsSync(cachePath)) {
			console.log(`Using cached ${toolName} for ${targetName}`);
			archive = await readFile(cachePath);
			const actualSha = sha256(archive);
			if (actualSha !== asset.sha256) {
				console.log(`Cached ${toolName} ${targetName} checksum mismatch, re-downloading`);
				archive = undefined;
			}
		}
		if (!archive) {
			console.log(`Downloading ${toolName} for ${targetName}`);
			archive = await download(asset.url);
			const actualSha = sha256(archive);
			if (actualSha !== asset.sha256) {
				throw new Error(`${toolName} ${targetName} checksum mismatch: expected ${asset.sha256}, got ${actualSha}`);
			}
			await mkdir(cacheDir, { recursive: true });
			await writeFile(cachePath, archive);
		}

		await extractArchive(cachePath, extractDir);

		const binaryPath = await findBinary(extractDir, asset.binary);
		if (!binaryPath) {
			throw new Error(`Could not find ${asset.binary} in ${archiveName}`);
		}

		const targetDir = path.join(outRoot, targetName);
		await mkdir(targetDir, { recursive: true });
		const targetPath = path.join(targetDir, asset.binary);
		await copyFile(binaryPath, targetPath);
		if (!asset.binary.endsWith(".exe")) {
			await chmod(targetPath, 0o755);
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function main() {
	if (process.env.PIZZA_SKIP_VENDOR_TOOLS === "1") {
		console.log("Skipping bundled fd/rg download because PIZZA_SKIP_VENDOR_TOOLS=1");
		return;
	}

	const names = selectedTargets();
	await mkdir(outRoot, { recursive: true });

	for (const name of names) {
		const target = targets[name];
		if (!target) {
			throw new Error(`Unsupported vendor tool target: ${name}`);
		}
		await rm(path.join(outRoot, name), { recursive: true, force: true });
		for (const [toolName, asset] of Object.entries(target)) {
			await installTool(name, toolName, asset);
		}
	}

	const files = [];
	for (const name of names) {
		const dir = path.join(outRoot, name);
		if (!existsSync(dir)) continue;
		const entries = await readdir(dir);
		for (const entry of entries) {
			files.push(path.relative(process.cwd(), path.join(dir, entry)));
		}
	}

	console.log(`Bundled ${files.length} fd/rg binaries:`);
	for (const file of files.sort()) {
		console.log(`  ${file}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
