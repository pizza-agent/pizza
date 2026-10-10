/**
 * Built-in extension: agent-browser
 *
 * Registers `agent-browser` (https://github.com/vercel-labs/agent-browser) — a fast
 * native-Rust browser automation CLI — as a first-class capability of Pizza.
 *
 * Design alignment with Pizza:
 * - Pizza exposes a single execution tool (`cli`). `agent-browser` stays a shell
 *   command invoked through `cli`, exactly like `git`/`npm`. This extension does
 *   NOT register a separate tool.
 * - It injects a concise usage skill into the system prompt via `before_agent_start`
 *   so the model knows how to drive the CLI.
 * - It exposes a `/browser` command for install / uninstall / status / disable /
 *   enable, so the lifecycle is user-controllable.
 *
 * Enable/disable and install state is persisted in `extensions.json`
 * (ExtensionRegistry, read by the resource loader on session start).
 */

import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir, SettingsManager } from "../../index.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";

/**
 * Short hint injected into the system prompt at the start of every agent turn.
 * The model can run `agent-browser --help` for the full command reference.
 */
const AGENT_BROWSER_PROMPT_HINT = `## agent-browser (built-in)

For web automation, use the \`agent-browser\` CLI via the \`cli\` tool (not a separate tool). If \`agent-browser --version\` fails, tell the user to run \`/browser install\` first.

  agent-browser open <url>     # open a page
  agent-browser snapshot -i    # interactive elements as @e1, @e2... refs
  agent-browser click @e3      # act on a ref — re-snapshot after any page change (refs go stale)
  agent-browser close          # close when done

Full reference: \`agent-browser --help\`.`;

/** Stable id used as this extension's key in extensions.json. */
export const AGENT_BROWSER_EXTENSION_ID = "agent-browser";

/**
 * Persist this extension's install state to extensions.json. Dynamic import:
 * builtin-extensions/index.js imports this module, so a static import back
 * would be a cycle.
 */
async function recordInstallState(cwd: string, state: BrowserAvailability): Promise<void> {
	const { recordBuiltinInstallState } = await import("../index.js");
	const registry = SettingsManager.create(cwd, getAgentDir()).extensions;
	recordBuiltinInstallState(registry, AGENT_BROWSER_EXTENSION_ID, state);
}

/** Result of checking whether `agent-browser` is installed. */
interface BrowserAvailability {
	installed: boolean;
	version?: string;
}

/**
 * Locate an executable on the PATH child processes get (agent bin dir +
 * inherited PATH + login-shell PATH) by looking at the filesystem only.
 */
async function findOnPath(name: string): Promise<string | undefined> {
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
			const candidate = join(dir, name + ext);
			try {
				if (!(await stat(candidate)).isFile()) continue;
				await access(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
				return candidate;
			} catch {
				// not here
			}
		}
	}
	return undefined;
}

/**
 * Read the version from the npm package that owns `bin`. Unix npm globals
 * symlink `<prefix>/bin/agent-browser` into `lib/node_modules/agent-browser/bin/`,
 * so walk up from the resolved target; Windows shims sit next to `node_modules/`.
 */
async function readPackageVersion(bin: string): Promise<string | undefined> {
	const resolved = await realpath(bin).catch(() => bin);
	const candidates = [join(dirname(bin), "node_modules", AGENT_BROWSER_EXTENSION_ID, "package.json")];
	for (let dir = dirname(resolved), i = 0; i < 4; dir = dirname(dir), i++) {
		candidates.push(join(dir, "package.json"));
	}
	for (const file of candidates) {
		try {
			const pkg = JSON.parse(await readFile(file, "utf-8")) as { name?: string; version?: string };
			if (pkg.name === AGENT_BROWSER_EXTENSION_ID) return pkg.version;
		} catch {
			// keep looking
		}
	}
	return undefined;
}

/**
 * Installed = an `agent-browser` executable is on PATH. Deliberately does not
 * spawn it: this runs every time the plugins page opens.
 */
export async function checkBrowserAvailable(_cwd: string): Promise<BrowserAvailability> {
	const bin = await findOnPath(AGENT_BROWSER_EXTENSION_ID);
	if (!bin) return { installed: false };
	return { installed: true, version: await readPackageVersion(bin) };
}

/** Run `agent-browser install` (downloads Chrome for Testing). */
export async function runAgentBrowserInstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec.js");
	const npmInstall = await execCommand("npm", ["install", "-g", "agent-browser"], cwd, {
		timeout: 180_000,
	});
	if (npmInstall.code !== 0) {
		return {
			ok: false,
			message: `npm install -g agent-browser failed (exit ${npmInstall.code})${
				npmInstall.stderr ? `:\n${npmInstall.stderr.trim()}` : ""
			}`,
		};
	}
	// The CLI is installed at this point even if the Chrome download below fails.
	await recordInstallState(cwd, await checkBrowserAvailable(cwd));
	const browserInstall = await execCommand("agent-browser", ["install"], cwd, {
		timeout: 300_000,
	});
	if (browserInstall.code !== 0) {
		return {
			ok: false,
			message: `agent-browser installed, but Chrome download failed (exit ${browserInstall.code})${
				browserInstall.stderr ? `:\n${browserInstall.stderr.trim()}` : ""
			}\nYou can retry with: agent-browser install`,
		};
	}
	return { ok: true, message: "agent-browser installed and Chrome for Testing downloaded." };
}

/** Run `npm uninstall -g agent-browser`. */
export async function runAgentBrowserUninstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec.js");
	const result = await execCommand("npm", ["uninstall", "-g", "agent-browser"], cwd, {
		timeout: 120_000,
	});
	if (result.code !== 0) {
		return {
			ok: false,
			message: `npm uninstall -g agent-browser failed (exit ${result.code})${
				result.stderr ? `:\n${result.stderr.trim()}` : ""
			}`,
		};
	}
	await recordInstallState(cwd, { installed: false });
	return { ok: true, message: "agent-browser CLI uninstalled." };
}

/** Persist enable/disable for this built-in extension in extensions.json. */
function persistDisabled(cwd: string, disabled: boolean): void {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir);
	settings.setBuiltinExtensionDisabled(AGENT_BROWSER_EXTENSION_ID, disabled);
}
function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		// Non-interactive (print/RPC) — echo so the result is visible.
		console.log(message);
	}
}

const USAGE = `Usage:
  /browser install     Install agent-browser CLI + Chrome for Testing
  /browser uninstall   Uninstall the agent-browser CLI
  /browser status      Show install status
  /browser disable     Disable this built-in extension (persists across sessions)
  /browser enable      Re-enable this built-in extension
  /browser help        Show this help`;

export const createAgentBrowserExtension: ExtensionFactory = (pizza: ExtensionAPI) => {
	// Inject a short hint into the system prompt at the start of every agent turn.
	// The full command reference is left for the model to discover via
	// `agent-browser --help` on demand, rather than burning ~700 tokens per turn.
	pizza.on("before_agent_start", (event) => {
		const sep = event.systemPrompt.endsWith("\n") ? "\n" : "\n\n";
		return { systemPrompt: event.systemPrompt + sep + AGENT_BROWSER_PROMPT_HINT };
	});

	pizza.registerCommand("browser", {
		description: "Manage the built-in agent-browser browser automation CLI.",
		async handler(args, ctx) {
			const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();
			const cwd = ctx.cwd;

			switch (subcommand) {
				case "install": {
					notify(ctx, "Installing agent-browser…", "info");
					const result = await runAgentBrowserInstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}
				case "uninstall": {
					notify(ctx, "Uninstalling agent-browser…", "info");
					const result = await runAgentBrowserUninstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					if (result.ok) {
						notify(ctx, "Tip: the built-in extension is still registered. Use /browser disable to hide it, or /browser enable to keep it.", "info");
					}
					return;
				}
				case "status": {
					const { getBuiltinInstallState } = await import("../index.js");
					const registry = SettingsManager.create(cwd, getAgentDir()).extensions;
					const available = await getBuiltinInstallState(registry, AGENT_BROWSER_EXTENSION_ID, cwd);
					const lines = [
						`Built-in extension: ${AGENT_BROWSER_EXTENSION_ID} (enabled)`,
						`CLI installed: ${available.installed ? "yes" : "no"}${available.version ? ` (${available.version})` : ""}`,
					];
					if (!available.installed) {
						lines.push("Run /browser install to install it.");
					}
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "disable": {
					persistDisabled(cwd, true);
					notify(ctx, "agent-browser built-in extension disabled. Reloading…", "info");
					await ctx.reload();
					return;
				}
				case "enable": {
					persistDisabled(cwd, false);
					notify(ctx, "agent-browser built-in extension enabled. Reloading…", "info");
					await ctx.reload();
					return;
				}
				case "help":
				default: {
					notify(ctx, USAGE, "info");
					return;
				}
			}
		},
	});
};
