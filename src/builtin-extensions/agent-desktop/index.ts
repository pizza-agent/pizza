/**
 * Built-in extension: agent-desktop
 *
 * Optional native desktop control for Pizza, backed by Vercel Labs
 * agent-desktop (Apache-2.0, https://github.com/vercel-labs/agent-desktop).
 * It is an execution tool, not a second agent: Pizza keeps planning, retry,
 * pause, resume, and approval. The model calls `_desktop` through the single
 * `cli` tool.
 *
 * Off until the user enables it (`pizza builtin enable agent-desktop`) and
 * grants OS accessibility permission. Web pages stay on `_browser`.
 */

import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../../core/config/settings-manager.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.js";
import { registerCommandRedactor } from "../../core/tools/command-redaction.js";
import {
	AGENT_DESKTOP_EXTENSION_ID,
	desktopBuiltinCommand,
	isAgentDesktopEnabled,
	setActiveDesktopCwd,
} from "./cli-command.js";
import { platformCaveat, redactDesktopCommandLine } from "./policy.js";
import { parseEnvelope, runAgentDesktop } from "./runner.js";

export { AGENT_DESKTOP_EXTENSION_ID };

let redactorRegistered = false;

interface DesktopAvailability {
	installed: boolean;
	version?: string;
}

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

async function readPackageVersion(bin: string): Promise<string | undefined> {
	const resolved = await realpath(bin).catch(() => bin);
	const candidates = [join(dirname(bin), "node_modules", "agent-desktop", "package.json")];
	for (let dir = dirname(resolved), i = 0; i < 4; dir = dirname(dir), i++) {
		candidates.push(join(dir, "package.json"));
	}
	for (const file of candidates) {
		try {
			const pkg = JSON.parse(await readFile(file, "utf-8")) as { name?: string; version?: string };
			if (pkg.name === "agent-desktop") return pkg.version;
		} catch {
			// keep looking
		}
	}
	return undefined;
}

export async function checkAgentDesktopInstalled(_cwd: string): Promise<DesktopAvailability> {
	const bin = await findOnPath("agent-desktop");
	if (!bin) return { installed: false };
	return { installed: true, version: await readPackageVersion(bin) };
}

async function recordInstallState(cwd: string, state: DesktopAvailability): Promise<void> {
	const { recordBuiltinInstallState } = await import("../index.js");
	const registry = SettingsManager.create(cwd, getAgentDir()).extensions;
	recordBuiltinInstallState(registry, AGENT_DESKTOP_EXTENSION_ID, state);
}

export async function runAgentDesktopInstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec/exec.js");
	const npmInstall = await execCommand("npm", ["install", "-g", "agent-desktop"], cwd, { timeout: 180_000 });
	if (npmInstall.code !== 0) {
		return {
			ok: false,
			message: `npm install -g agent-desktop failed (exit ${npmInstall.code})${npmInstall.stderr ? `:\n${npmInstall.stderr.trim()}` : ""}`,
		};
	}
	await recordInstallState(cwd, await checkAgentDesktopInstalled(cwd));
	return {
		ok: true,
		message: "agent-desktop CLI installed. Enable it with `pizza builtin enable agent-desktop` if you have not already, then grant Accessibility (`/desktop permissions`) before use.",
	};
}

export async function runAgentDesktopUninstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec/exec.js");
	const result = await execCommand("npm", ["uninstall", "-g", "agent-desktop"], cwd, { timeout: 120_000 });
	if (result.code !== 0) {
		return {
			ok: false,
			message: `npm uninstall -g agent-desktop failed (exit ${result.code})${result.stderr ? `:\n${result.stderr.trim()}` : ""}`,
		};
	}
	await recordInstallState(cwd, { installed: false });
	return { ok: true, message: "agent-desktop CLI uninstalled." };
}

function permissionRows(accessibility: boolean, screen: boolean) {
	return [
		{
			kind: "accessibility" as const,
			label: "Accessibility",
			description: "Allows agent-desktop to read native controls and to click or type in approved app windows.",
			granted: accessibility,
			required: true,
		},
		{
			kind: "screenRecording" as const,
			label: "Screen Recording",
			description: "Required only for _desktop screenshot (and trace screenshots). Ordinary snapshots use the accessibility tree.",
			granted: screen,
			required: false,
		},
	];
}

async function permissionState(cwd: string, installed: boolean) {
	const caveat = platformCaveat();
	if (!installed) {
		return {
			supported: process.platform === "darwin" || process.platform === "win32" || process.platform === "linux",
			installed: false,
			ready: false,
			message: `Install agent-desktop before granting permissions (\`/desktop install\`).${caveat ? ` ${caveat}` : ""}`,
			permissions: permissionRows(false, false),
		};
	}
	const run = await runAgentDesktop(["permissions"], { cwd, timeout: 20_000 });
	const envelope = parseEnvelope(run.stdout);
	const data = envelope?.data as
		| {
				accessibility?: { state?: string };
				screen_recording?: { state?: string };
		  }
		| undefined;
	const accessibility = data?.accessibility?.state === "granted";
	const screenState = data?.screen_recording?.state;
	const screen = screenState === "granted" || screenState === "not_required";
	const ready = accessibility;
	const base = ready
		? "Accessibility is granted."
		: process.platform === "darwin"
			? "Grant Accessibility to the app that launches Pizza (Terminal, the Pizza app, or agent-desktop). Screen Recording is only needed for screenshots."
			: "Accessibility is not granted.";
	return {
		supported: true,
		installed: true,
		ready,
		message: [base, caveat].filter(Boolean).join(" "),
		permissions: permissionRows(accessibility, screen),
	};
}

export async function getAgentDesktopPermissionStatus(cwd: string) {
	const installed = (await checkAgentDesktopInstalled(cwd)).installed;
	return permissionState(cwd, installed);
}

export async function recheckAgentDesktopPermissionStatus(cwd: string) {
	return getAgentDesktopPermissionStatus(cwd);
}

export async function openAgentDesktopPermissionSettings(cwd: string, _kind: "accessibility" | "screenRecording") {
	if (!(await checkAgentDesktopInstalled(cwd)).installed) {
		return { ok: false, message: "Install agent-desktop before opening permission settings." };
	}
	if (process.platform !== "darwin") {
		return {
			ok: false,
			message: platformCaveat() ?? "Permission settings are only opened automatically on macOS.",
		};
	}
	const run = await runAgentDesktop(["permissions", "--guide"], { cwd, timeout: 20_000 });
	const envelope = parseEnvelope(run.stdout);
	if (run.code !== 0 && envelope?.ok !== true) {
		return {
			ok: false,
			message: envelope?.error?.message || run.stderr.trim() || "agent-desktop permissions --guide failed. Open System Settings → Privacy & Security → Accessibility manually.",
		};
	}
	return {
		ok: true,
		message: "Opened the macOS privacy pane. Enable Accessibility (and Screen Recording if you need screenshots) for the app that launches Pizza, then recheck.",
	};
}

function persistDisabled(cwd: string, disabled: boolean): void {
	SettingsManager.create(cwd, getAgentDir()).setBuiltinExtensionDisabled(AGENT_DESKTOP_EXTENSION_ID, disabled);
}

function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type ?? "info");
	else console.log(message);
}

const USAGE = `Usage:
  /desktop install      Install the agent-desktop CLI
  /desktop uninstall    Uninstall the agent-desktop CLI
  /desktop status       Install, permission, and enablement status
  /desktop permissions  Open the macOS Accessibility guide (other platforms: print the requirement)
  /desktop enable       Enable this built-in (also: pizza builtin enable agent-desktop)
  /desktop disable      Disable this built-in
  /desktop help         Show this help`;

const PROMPT_HINT = `## desktop automation (agent-desktop, optional)

Native desktop apps only, through the \`_desktop\` cli command. Web pages stay on \`_browser\` (agent-browser). Do not drive browser page content from here.

  _desktop snapshot --app Notes -i --compact
  _desktop click @<snapshot>:eN
  _desktop type @<snapshot>:eN "text"

Refs are bound to this workspace and thread. After any action, or if the user uses the computer, snapshot again — never reuse a stale ref. Send, pay, delete, quit, and account changes wait for runtime approval. \`/desktop status\` shows permissions. macOS Accessibility is the supported path.`;

export const createAgentDesktopExtension: ExtensionFactory = (pizza: ExtensionAPI) => {
	if (!redactorRegistered) {
		redactorRegistered = true;
		registerCommandRedactor(redactDesktopCommandLine);
	}
	pizza.registerCliCommand(desktopBuiltinCommand);
	pizza.on("session_start", (_event, ctx) => {
		setActiveDesktopCwd(ctx.cwd);
	});
	pizza.on("before_agent_start", (event, ctx) => {
		if (!isAgentDesktopEnabled(ctx.cwd)) return undefined;
		const sep = event.systemPrompt.endsWith("\n") ? "\n" : "\n\n";
		return { systemPrompt: event.systemPrompt + sep + PROMPT_HINT };
	});
	pizza.registerCommand("desktop", {
		description: "Manage the optional agent-desktop native desktop automation CLI.",
		async handler(args, ctx) {
			const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();
			const cwd = ctx.cwd;
			switch (subcommand) {
				case "install": {
					notify(ctx, "Installing agent-desktop…", "info");
					const result = await runAgentDesktopInstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}
				case "uninstall": {
					const result = await runAgentDesktopUninstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}
				case "status": {
					const available = await checkAgentDesktopInstalled(cwd);
					const permissions = await permissionState(cwd, available.installed);
					const enabled = isAgentDesktopEnabled(cwd);
					notify(
						ctx,
						[
							`agent-desktop: ${enabled ? "enabled" : "disabled (pizza builtin enable agent-desktop)"}`,
							`CLI: ${available.installed ? `installed${available.version ? ` (${available.version})` : ""}` : "not installed"}`,
							`Accessibility: ${permissions.permissions[0]?.granted ? "granted" : "missing"}`,
							permissions.message ?? "",
						]
							.filter(Boolean)
							.join("\n"),
						permissions.ready && enabled ? "info" : "warning",
					);
					return;
				}
				case "permissions": {
					const result = await openAgentDesktopPermissionSettings(cwd, "accessibility");
					notify(ctx, result.message, result.ok ? "info" : "warning");
					return;
				}
				case "enable":
					persistDisabled(cwd, false);
					setActiveDesktopCwd(cwd);
					notify(ctx, "agent-desktop enabled. Grant Accessibility with /desktop permissions before the first action. Web pages stay on /browser.", "info");
					return;
				case "disable":
					persistDisabled(cwd, true);
					notify(ctx, "agent-desktop disabled. It stays off until you enable it again.", "info");
					return;
				default:
					notify(ctx, USAGE, "info");
			}
		},
	});
};
