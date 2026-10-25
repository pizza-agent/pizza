#!/usr/bin/env node

/**
 * Build the installable Pizza remote server package.
 *
 * The archive contains the built CLI tree and runtime assets, but excludes the
 * desktop-only compiled binary so remote installation can use its own private
 * Node runtime.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const outputDir = join(root, "dist", "remote");
const stagingRoot = mkdtempSync(join(tmpdir(), "pizza-remote-package-"));
const stagingDist = join(stagingRoot, "dist");

if (!existsSync(join(root, "dist", "src", "cli.js"))) {
	throw new Error("dist/src/cli.js is missing; run the normal build first");
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(stagingDist, { recursive: true });
copyFileSync(join(root, "package.json"), join(stagingRoot, "package.json"));
if (existsSync(join(root, "README.md"))) {
	copyFileSync(join(root, "README.md"), join(stagingRoot, "README.md"));
}

cpSync(join(root, "dist"), stagingDist, {
	recursive: true,
	filter(source) {
		const normalized = source.replaceAll("\\", "/");
		const remoteDir = join(root, "dist", "remote").replaceAll("\\", "/");
		if (normalized === remoteDir || normalized.startsWith(`${remoteDir}/`)) return false;
		if (normalized.endsWith("/dist/pizza") || normalized.endsWith("/dist/pizza.exe")) return false;
		return true;
	},
});
const bundledProtocolDir = join(stagingRoot, "node_modules", "@tomsun28", "pizza-protocol");
mkdirSync(bundledProtocolDir, { recursive: true });
cpSync(join(root, "packages", "protocol"), bundledProtocolDir, { recursive: true });

const packOutput = execFileSync(
	"npm",
	["pack", "--pack-destination", stagingRoot, "--json"],
	{
		cwd: stagingRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	},
);
const packed = JSON.parse(packOutput);
const packedFile = packed[0]?.filename;
if (!packedFile) {
	throw new Error("npm pack did not return an archive name");
}

const outputName = `pizza-server-${version}.tgz`;
const outputPath = join(outputDir, outputName);
copyFileSync(join(stagingRoot, packedFile), outputPath);
const bytes = readFileSync(outputPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(
	join(outputDir, "manifest.json"),
	`${JSON.stringify(
		{
			schemaVersion: 1,
			version,
			archive: outputName,
			sizeBytes: bytes.length,
			sha256,
			nodeRuntime: "22.23.1",
		},
		null,
		2,
	)}\n`,
);

console.log(`[build-remote-server] wrote ${outputPath}`);
console.log(`[build-remote-server] sha256=${sha256} size=${bytes.length}`);
