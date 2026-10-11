/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../../utils/shell.js";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();

// ============================================================================
// Trust-on-first-use gate for "!command" config values
// ============================================================================
//
// "!cmd" values in models.json / auth.json execute arbitrary shell commands
// when resolved. Both files are hot-reloaded, and the LLM has a write tool —
// so without a gate, "write models.json with an apiKey of !<payload>, then
// trigger a provider reload" was a silent self-privilege-escalation chain.
//
// Defense: at process startup the config owners (ModelRegistry, AuthStorage)
// register every "!command" present in their files; createSessionFacade then
// SEALS the set before the first LLM turn can run. After sealing, a command
// string not registered at startup is refused (with a restart hint) instead
// of executed. Editing configs by hand still works — it just needs a restart,
// which is exactly the property that turns a silent mid-session escalation
// into a visible, user-mediated change.

let trustSealed = false;
const trustedCommands = new Set<string>();

/** Register "!command" strings found in a config file at load time. No-op after sealing. */
export function registerTrustedConfigCommands(commands: Iterable<string>): void {
	if (trustSealed) return;
	for (const command of commands) {
		if (typeof command === "string" && command.startsWith("!")) trustedCommands.add(command);
	}
}

/** Recursively collect every string value starting with "!" from parsed config JSON. */
export function collectConfigCommands(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		if (value.startsWith("!")) out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) collectConfigCommands(item, out);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectConfigCommands(item, out);
	}
	return out;
}

/** Seal the trusted set. Commands registered afterwards are ignored; unknown commands are refused. */
export function sealConfigCommandTrust(): void {
	trustSealed = true;
}

/** Test hook. */
export function resetConfigCommandTrustForTest(): void {
	trustSealed = false;
	trustedCommands.clear();
}

function isCommandTrusted(commandConfig: string): boolean {
	if (!trustSealed) return true;
	return trustedCommands.has(commandConfig);
}

function refuseUntrustedCommand(commandConfig: string): void {
	// Redact the payload — it is attacker-controlled and may be huge.
	const preview = commandConfig.slice(1, 61);
	console.warn(
		`Refusing to execute config command that was not present at startup: "${preview}${commandConfig.length > 61 ? "…" : ""}". ` +
			"Commands in models.json/auth.json are trusted as of process start; restart Pizza to trust this change.",
	);
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	if (!isCommandTrusted(commandConfig)) {
		refuseUntrustedCommand(commandConfig);
		return undefined;
	}
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
	if (!isCommandTrusted(commandConfig)) {
		refuseUntrustedCommand(commandConfig);
		return undefined; // NOT cached — a restart (or unseal in tests) may allow it
	}
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommandUncached(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
	const resolvedValue = resolveConfigValueUncached(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
