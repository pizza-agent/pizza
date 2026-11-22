/**
 * Copy the current platform's agent-desktop binary next to Pizza's packaged
 * executable. The npm package already contains every platform; the desktop
 * app only needs the one it is built for.
 *
 *   node scripts/copy-agent-desktop.mjs
 *   node scripts/copy-agent-desktop.mjs --placeholder
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const placeholder = process.argv.includes("--placeholder");

function empty(name) {
	mkdirSync(dist, { recursive: true });
	const file = join(dist, name);
	if (!existsSync(file)) writeFileSync(file, "");
}

const FFI_NAMES = {
	darwin: "libagent_desktop_ffi.dylib",
	linux: "libagent_desktop_ffi.so",
	win32: "agent_desktop_ffi.dll",
};
const ffiName = FFI_NAMES[process.platform];

function stageFfiDylib() {
	if (!ffiName) return;
	const cache = join(root, ".desktop-ffi", ffiName);
	const dest = join(dist, ffiName);
	if (existsSync(cache) && !existsSync(dest)) {
		mkdirSync(dist, { recursive: true });
		copyFileSync(cache, dest);
		console.log(`staged ${ffiName} to dist/`);
	}
}

if (placeholder) {
	empty(process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop");
	empty("agent-desktop-macos-helper");
	empty("agent-desktop-linux-clipboard-owner");
	if (ffiName) empty(ffiName);
	process.exit(0);
}

const require = createRequire(join(root, "package.json"));
let packageJson;
try {
	packageJson = require.resolve("agent-desktop/package.json");
} catch {
	console.error("agent-desktop is not installed. It is an optional dependency of Pizza; reinstall dependencies.");
	process.exit(1);
}

const packageRoot = dirname(packageJson);
const { resolve, helperNames } = require(join(packageRoot, "lib/platform.js"));
const entry = resolve(process.platform, process.arch);
if (!entry?.released) {
	console.error(`agent-desktop has no binary for ${process.platform}-${process.arch}.`);
	process.exit(1);
}

const sourceBinary = join(packageRoot, "bin", entry.binaryName);
if (!existsSync(sourceBinary)) {
	console.error(`Missing ${sourceBinary}`);
	process.exit(1);
}

mkdirSync(dist, { recursive: true });
const destName = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";
const destBinary = join(dist, destName);
copyFileSync(sourceBinary, destBinary);
if (process.platform !== "win32") chmodSync(destBinary, 0o755);

const [helperName] = helperNames(entry);
if (helperName) {
	const suffixed = join(packageRoot, "bin", `${helperName}-${process.platform}-${process.arch}`);
	const plain = join(packageRoot, "bin", helperName);
	const sourceHelper = existsSync(suffixed) ? suffixed : plain;
	if (!existsSync(sourceHelper)) {
		console.error(`Missing helper ${sourceHelper}`);
		process.exit(1);
	}
	const destHelper = join(dist, helperName);
	copyFileSync(sourceHelper, destHelper);
	if (process.platform !== "win32") chmodSync(destHelper, 0o755);
	console.log(`copied ${entry.binaryName} and ${helperName} to dist/`);
} else {
	console.log(`copied ${entry.binaryName} to dist/${destName}`);
}

// Stage the FFI dylib when scripts/build-desktop-ffi.sh has produced one.
// Optional: the desktop worker CLI-fallbacks when it is absent.
stageFfiDylib();
