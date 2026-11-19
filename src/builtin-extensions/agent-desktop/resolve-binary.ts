/**
 * Find the agent-desktop executable that ships with Pizza.
 *
 * Search order:
 * 1. The `agent-desktop` package installed with Pizza (node_modules).
 * 2. A copy placed next to a packaged Pizza binary (desktop app resources).
 * 3. `agent-desktop` on PATH, for a manual install.
 *
 * The native file is preferred. The Node launcher in the package is only used
 * when that native file is absent, and only when the current process can run
 * JavaScript (node or bun, not the compiled Pizza binary).
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned in package.json optionalDependencies. Upstream ships every platform in one tarball. */
export const BUNDLED_AGENT_DESKTOP_VERSION = "1.3.1";

export type AgentDesktopSource = "bundled" | "alongside" | "path";

export interface ResolvedAgentDesktop {
	/** Program to spawn. */
	command: string;
	/** Arguments inserted before the user's agent-desktop arguments. */
	argsPrefix: string[];
	source: AgentDesktopSource;
	version?: string;
	env?: NodeJS.ProcessEnv;
}

const MACOS_HELPER_ENV = "AGENT_DESKTOP_MACOS_HELPER_PATH";

interface PlatformBinary {
	binary: string;
	/** Helper file name inside the npm package bin directory. */
	packagedHelper?: string;
	/** Helper file name when copied next to a packaged Pizza binary. */
	alongsideHelper?: string;
}

const PLATFORM_BINARIES: Record<string, PlatformBinary> = {
	"darwin-arm64": {
		binary: "agent-desktop-darwin-arm64",
		packagedHelper: "agent-desktop-macos-helper-darwin-arm64",
		alongsideHelper: "agent-desktop-macos-helper",
	},
	"darwin-x64": {
		binary: "agent-desktop-darwin-x64",
		packagedHelper: "agent-desktop-macos-helper-darwin-x64",
		alongsideHelper: "agent-desktop-macos-helper",
	},
	"linux-arm64": {
		binary: "agent-desktop-linux-arm64",
		packagedHelper: "agent-desktop-linux-clipboard-owner-linux-arm64",
		alongsideHelper: "agent-desktop-linux-clipboard-owner",
	},
	"linux-x64": {
		binary: "agent-desktop-linux-x64",
		packagedHelper: "agent-desktop-linux-clipboard-owner-linux-x64",
		alongsideHelper: "agent-desktop-linux-clipboard-owner",
	},
	"win32-arm64": { binary: "agent-desktop-win32-arm64.exe" },
	"win32-x64": { binary: "agent-desktop-win32-x64.exe" },
};

function platformKey(platform = process.platform, arch = process.arch): string {
	return `${platform}-${arch}`;
}

export function platformBinary(platform = process.platform, arch = process.arch): PlatformBinary | undefined {
	return PLATFORM_BINARIES[platformKey(platform, arch)];
}

function isExecutable(file: string): boolean {
	if (!existsSync(file)) return false;
	if (process.platform === "win32") return true;
	try {
		chmodSync(file, 0o755);
	} catch {
		// A read-only install can still be executable already.
	}
	return true;
}

function canRunJavaScript(execPath: string): boolean {
	const base = basename(execPath).toLowerCase();
	return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}

function helperEnv(directory: string, spec: PlatformBinary | undefined): NodeJS.ProcessEnv | undefined {
	if (process.platform !== "darwin" || !spec) return undefined;
	const packaged = spec.packagedHelper ? join(directory, spec.packagedHelper) : undefined;
	const plain = spec.alongsideHelper ? join(directory, spec.alongsideHelper) : undefined;
	const helper = packaged && existsSync(packaged) ? packaged : plain && existsSync(plain) ? plain : undefined;
	if (!helper) return undefined;
	return { [MACOS_HELPER_ENV]: helper };
}

function readPackageVersion(packageJsonPath: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

/** Resolve a native binary inside an extracted agent-desktop package. */
export function binaryFromPackageRoot(packageRoot: string): ResolvedAgentDesktop | undefined {
	const spec = platformBinary();
	if (!spec) return undefined;
	const binDir = join(packageRoot, "bin");
	const native = join(binDir, spec.binary);
	const version = readPackageVersion(join(packageRoot, "package.json")) ?? BUNDLED_AGENT_DESKTOP_VERSION;
	if (isExecutable(native)) {
		return {
			command: native,
			argsPrefix: [],
			source: "bundled",
			version,
			env: helperEnv(binDir, spec),
		};
	}
	const launcher = join(binDir, "agent-desktop");
	if (existsSync(launcher) && canRunJavaScript(process.execPath)) {
		return {
			command: process.execPath,
			argsPrefix: [launcher],
			source: "bundled",
			version,
		};
	}
	return undefined;
}

function bundledFromNodeModules(): ResolvedAgentDesktop | undefined {
	try {
		const require = createRequire(fileURLToPath(import.meta.url));
		const packageJson = require.resolve("agent-desktop/package.json");
		return binaryFromPackageRoot(dirname(packageJson));
	} catch {
		return undefined;
	}
}

function alongsidePizzaBinary(): ResolvedAgentDesktop | undefined {
	const spec = platformBinary();
	if (!spec) return undefined;
	const directory = dirname(process.execPath);
	const name = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";
	const binary = join(directory, name);
	if (!isExecutable(binary)) return undefined;
	const helperName = spec.alongsideHelper;
	const helper = helperName ? join(directory, helperName) : undefined;
	const env = process.platform === "darwin" && helper && existsSync(helper) ? { [MACOS_HELPER_ENV]: helper } : undefined;
	return { command: binary, argsPrefix: [], source: "alongside", env };
}

async function fromPath(): Promise<ResolvedAgentDesktop | undefined> {
	const { constants: fsConstantsAccess } = await import("node:fs");
	const { access, stat } = await import("node:fs/promises");
	const { delimiter } = await import("node:path");
	const { prefetchLoginShellPath } = await import("../../utils/login-shell-path.js");
	const { getShellEnv } = await import("../../utils/shell.js");
	await prefetchLoginShellPath();
	const env = getShellEnv();
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const isWindows = process.platform === "win32";
	const exts = isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
	for (const dir of (env[pathKey] ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, "agent-desktop" + ext);
			try {
				if (!(await stat(candidate)).isFile()) continue;
				await access(candidate, isWindows ? fsConstantsAccess.F_OK : fsConstantsAccess.X_OK);
				return { command: candidate, argsPrefix: [], source: "path" };
			} catch {
				// keep looking
			}
		}
	}
	return undefined;
}

export async function resolveAgentDesktop(): Promise<ResolvedAgentDesktop | undefined> {
	return bundledFromNodeModules() ?? alongsidePizzaBinary() ?? (await fromPath());
}
