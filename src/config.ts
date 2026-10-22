import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return "Download the latest Pizza binary from the project releases page";
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package-level assets (package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js: walks up from __dirname to find the package root (directory with package.json)
 * - For tsx (src/): returns the package root
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PIZZA_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	if (dir.endsWith("/dist") || dir.endsWith("\\dist")) {
		dir = dirname(dir);
	}
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/packages/tui/theme/
 * - For tsx (src/): packages/tui/theme/ (relative to project root)
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// __dirname is src/ or dist/ — themes are now in packages/tui/theme/
	return join(__dirname, "..", "packages", "tui", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	// __dirname is always dist/ or src/ — assets live at the same relative path from either
	return join(__dirname, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}
/**
 * Get path to built-in skills directory (shipped with package)
 * - For Bun binary: builtin-skills/ next to executable
 * - For Node.js (dist/): dist/src/builtin-skills/
 * - For tsx (src/): src/builtin-skills/
 */
export function getBuiltinSkillsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "builtin-skills");
	}
	// __dirname is always dist/src or src — built-in skills live at the same relative path
	return join(__dirname, "builtin-skills");
}


/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/packages/tui/assets/
 * - For tsx (src/): packages/tui/assets/ (relative to project root)
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	// __dirname is src/ or dist/ — assets are now in packages/tui/assets/
	return join(__dirname, "..", "packages", "tui", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get path to managed binaries shipped with the package.
 * - For Bun binary: vendor/bin/ next to executable
 * - For Node.js (dist/): dist/vendor/bin/
 * - For tsx (src/): dist/vendor/bin/ when release assets have been built
 */
export function getBundledBinDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "vendor", "bin");
	}
	const packageDir = getPackageDir();
	// Dev builds run from dist/src, so getPackageDir() finds the copied
	// dist/package.json and returns dist/ itself — in that layout vendor
	// assets live directly at <pkg>/vendor/bin. Installed packages keep
	// them under <pkg>/dist/vendor/bin. Probe both so fd/rg resolve either way.
	const direct = join(packageDir, "vendor", "bin");
	if (existsSync(direct)) return direct;
	return join(packageDir, "dist", "vendor", "bin");
}

// =============================================================================
// App Config (from package.json pizzaConfig)
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));

const appConfig = pkg.pizzaConfig ?? {};

export const APP_NAME: string = appConfig.name || "pizza";
export const CONFIG_DIR_NAME: string = appConfig.configDir || ".pizza";
export const VERSION: string = pkg.version;

export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://pizza.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PIZZA_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pizza/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pizza/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

// =============================================================================
// Persistent (main) Agent Paths (~/.pizza/main/*)
// =============================================================================

function expandTilde(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/**
 * Get the persistent ("main") agent working directory.
 * Default: ~/.pizza/main. Overridable via --main-dir (passed as `override`).
 */
export function getMainDir(override?: string): string {
	if (override) {
		return resolve(expandTilde(override));
	}
	return join(homedir(), CONFIG_DIR_NAME, "main");
}

/** Get the main agent long-term memory directory (default: <mainDir>/memory). */
export function getMainMemoryDir(mainDir?: string, override?: string): string {
	if (override) {
		return resolve(expandTilde(override));
	}
	return join(getMainDir(mainDir), "memory");
}

/** Get the main agent soul file path (<mainDir>/SOUL.md). */
export function getMainSoulPath(mainDir?: string): string {
	return join(getMainDir(mainDir), "SOUL.md");
}
