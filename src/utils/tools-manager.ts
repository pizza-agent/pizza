import chalk from "chalk";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { getBinDir, getBundledBinDir } from "../config.js";

const TOOLS_DIR = getBinDir();

function isOfflineModeEnabled(): boolean {
	const value = process.env.PIZZA_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	binaryName: string; // Name of the binary
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		binaryName: "fd",
	},
	rg: {
		name: "ripgrep",
		binaryName: "rg",
	},
};

// Check if a command exists in PATH by trying to run it.
// Cached: this used to spawn `<cmd> --version` on every grep/find tool call —
// a whole process spawn per search in large repos.
const commandExistsCache = new Map<string, boolean>();
function commandExists(cmd: string): boolean {
	const cachedResult = commandExistsCache.get(cmd);
	if (cachedResult !== undefined) return cachedResult;
	let exists = false;
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		exists = result.error === undefined || result.error === null;
	} catch {
		exists = false;
	}
	commandExistsCache.set(cmd, exists);
	return exists;
}

function executableName(config: ToolConfig): string {
	return config.binaryName + (platform() === "win32" ? ".exe" : "");
}

function platformArchKey(): string {
	return `${platform()}-${arch()}`;
}

export function getBundledToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	const bundledPath = join(getBundledBinDir(), platformArchKey(), executableName(config));
	if (existsSync(bundledPath)) {
		return bundledPath;
	}
	return null;
}

// Get the path to a tool (system-wide or in our tools dir). The PATH probe
// spawn inside commandExists is cached; the existsSync checks run per call
// so late-set PIZZA_PACKAGE_DIR / freshly installed tools still resolve.
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check binaries shipped with the package first for stable installs.
	const bundledPath = getBundledToolPath(tool);
	if (bundledPath) {
		return bundledPath;
	}

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, executableName(config));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	if (commandExists(config.binaryName)) {
		return config.binaryName;
	}

	return null;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

// Ensure a tool is available
// Returns the path to the tool, or undefined if unavailable
export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return undefined;
	}

	// Tool not found - automatic download disabled
	if (!silent) {
		console.log(chalk.yellow(`${config.name} not found. Please install it manually.`));
	}
	return undefined;
}
