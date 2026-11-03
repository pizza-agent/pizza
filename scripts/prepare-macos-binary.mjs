/** Repair Bun's linker signature before bundling, then check the binary can run. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("[macos-binary] Skipping macOS code signing on this platform.");
	process.exit(0);
}

const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify";
if (verifyOnly) args.shift();
if (args.length > 1 || args[0]?.startsWith("--")) {
	throw new Error("Usage: node scripts/prepare-macos-binary.mjs [--verify] [binary]");
}
const binary = args[0] ? resolve(args[0]) : fileURLToPath(new URL("../dist/pizza", import.meta.url));

function run(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 30_000 });
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} failed (${result.signal ?? result.status}): ${result.error?.message ?? ""}\n` +
			`${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	return result.stdout.trim();
}

// Bun's compiled Mach-O may retain a stale linker signature. Sign only after
// compilation has finished; the updater's .sig file does not sign Mach-O code.
// --verify is read-only so release checks never repair a broken artifact.
if (!verifyOnly) run("codesign", ["--force", "--sign", "-", binary]);
run("codesign", ["--verify", "--strict", "--verbose=2", binary]);
const version = run(binary, ["--version"]);
console.log(`[macos-binary] Signature and startup verified: ${binary} (${version})`);
