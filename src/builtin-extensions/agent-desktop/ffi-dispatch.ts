/**
 * Translate the vendor argv that cli-command emits into FFI calls.
 *
 * Only the envelope-producing hot path is handled in-process (status,
 * snapshot, ref actions). Anything unrecognized — list-*, find, get, is,
 * permissions, clipboard, screenshot, session, wait, open/close — returns
 * null and the worker falls back to spawning the agent-desktop CLI, so the
 * FFI surface can grow incrementally without breaking commands.
 */

import { type FfiAdapter, FFI_ACTION_KIND, buildAction } from "./ffi.js";
import type { DesktopRunResult } from "./runner.js";

const SURFACES: Record<string, number> = {
	window: 0,
	focused: 1,
	menu: 2,
	menubar: 3,
	sheet: 4,
	popover: 5,
	alert: 6,
	desktop: 7,
	taskbar: 8,
	"system-tray": 9,
	"quick-settings": 10,
	"notification-center": 11,
	toolbar: 12,
	dock: 13,
	spotlight: 14,
	"menu-bar-extras": 15,
	"system-tray-overflow": 16,
	"start-menu": 17,
	"action-center": 18,
};

const DIRECTIONS: Record<string, number> = { up: 0, down: 1, left: 2, right: 3 };

/** Action kinds whose only payload is an optional text field. */
const TEXT_ACTIONS = new Set(["type", "set-value", "select"]);
/** Action kinds with no payload beyond kind + ref. */
const PLAIN_ACTIONS = new Set([
	"click",
	"double-click",
	"right-click",
	"triple-click",
	"set-focus",
	"expand",
	"collapse",
	"toggle",
	"check",
	"uncheck",
	"clear",
	"hover",
]);

interface ParsedArgs {
	flags: Map<string, string | true>;
	positionals: string[];
}

function parseArgs(tokens: string[]): ParsedArgs {
	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-i") {
			flags.set("interactive-only", true);
		} else if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 0) {
				flags.set(token.slice(2, eq), token.slice(eq + 1));
			} else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
				flags.set(token.slice(2), tokens[++i]);
			} else {
				flags.set(token.slice(2), true);
			}
		} else {
			positionals.push(token);
		}
	}
	return { flags, positionals };
}

function ok(envelope: string): DesktopRunResult {
	return { code: 0, stdout: envelope, stderr: "" };
}

const RESULT_CODES: Record<number, string> = {
	[-1]: "PERM_DENIED",
	[-2]: "ELEMENT_NOT_FOUND",
	[-3]: "APP_NOT_FOUND",
	[-4]: "ACTION_FAILED",
	[-5]: "ACTION_NOT_SUPPORTED",
	[-6]: "STALE_REF",
	[-7]: "WINDOW_NOT_FOUND",
	[-8]: "PLATFORM_NOT_SUPPORTED",
	[-9]: "TIMEOUT",
	[-10]: "INVALID_ARGS",
	[-11]: "NOTIFICATION_NOT_FOUND",
	[-12]: "INTERNAL",
	[-13]: "SNAPSHOT_NOT_FOUND",
	[-14]: "POLICY_DENIED",
	[-15]: "AMBIGUOUS_TARGET",
	[-16]: "APP_UNRESPONSIVE",
	[-17]: "SANDBOX_NOT_FOUND",
};

function envelope(command: string, data: Record<string, unknown>): DesktopRunResult {
	return ok(JSON.stringify({ version: "2.6", ok: true, command, data }));
}

function fail(message: string): DesktopRunResult {
	return {
		code: 1,
		stdout: JSON.stringify({ ok: false, error: { code: "INTERNAL", message } }),
		stderr: "",
	};
}

function failFromRc(command: string, rc: number): DesktopRunResult {
	return {
		code: 1,
		stdout: JSON.stringify({
			version: "2.6",
			ok: false,
			command,
			error: { code: RESULT_CODES[rc] ?? "INTERNAL", message: `agent-desktop returned ${rc}` },
		}),
		stderr: "",
	};
}

/**
 * Returns null when the command is outside the FFI-covered subset — the
 * caller then runs it through the CLI. Session selection (`--session`) is
 * honored by the FFI adapter; the flag itself is consumed here.
 */
export function dispatchViaFfi(ffi: FfiAdapter, argv: string[], stdin?: string): DesktopRunResult | null {
	const [subcommand, ...rest] = argv;
	const parsed = parseArgs(rest);
	const sessionId = typeof parsed.flags.get("session") === "string" ? (parsed.flags.get("session") as string) : undefined;

	try {
		if (subcommand === "status") {
			return ok(ffi.status());
		}

		if (subcommand === "version") {
			return ok(ffi.version());
		}

		// Clipboard goes to the CLI: the FFI adapter's clipboard read/write
		// returns ACTION_NOT_SUPPORTED on macOS where the CLI uses a working
		// path (verified against the live binary).
		if (subcommand === "clipboard-get" || subcommand === "clipboard-set" || subcommand === "clipboard-clear") {
			return null;
		}

		if (subcommand === "list-apps") {
			const apps = ffi.listApps().map((app) => ({ name: app.name, pid: app.pid, bundle_id: app.bundleId }));
			return envelope("list-apps", { apps });
		}

		if (subcommand === "close-app") {
			const id = parsed.positionals[0] ?? (typeof parsed.flags.get("app") === "string" ? parsed.flags.get("app") : undefined);
			if (typeof id !== "string" || !id) return null;
			const rc = ffi.closeApp(id, parsed.flags.has("force"));
			return rc === 0 ? envelope("close-app", { closed: id }) : failFromRc("close-app", rc);
		}

		if (subcommand === "snapshot") {
			// --root has no FFI equivalent; subtree snapshots go to the CLI.
			if (parsed.flags.has("root") || parsed.flags.has("window-id")) return null;
			const surfaceFlag = parsed.flags.get("surface");
			const surface = typeof surfaceFlag === "string" ? SURFACES[surfaceFlag] : SURFACES.window;
			if (surface === undefined) return null;
			const depthFlag = parsed.flags.get("max-depth");
			const maxDepth = typeof depthFlag === "string" ? Number.parseInt(depthFlag, 10) : 10;
			const appFlag = parsed.flags.get("app");
			return ok(
				ffi.snapshot(
					{
						app: typeof appFlag === "string" ? appFlag : undefined,
						surface,
						maxDepth: Number.isFinite(maxDepth) ? maxDepth : 10,
						interactiveOnly: parsed.flags.has("interactive-only"),
						compact: parsed.flags.has("compact"),
					},
					sessionId,
				),
			);
		}

		const kind = FFI_ACTION_KIND[subcommand];
		if (kind === undefined) return null;
		const ref = parsed.positionals.find((token) => token.startsWith("@"));
		if (!ref) return null;

		if (PLAIN_ACTIONS.has(subcommand)) {
			return ok(ffi.executeRef(ref, buildAction({ kind }), sessionId));
		}
		if (TEXT_ACTIONS.has(subcommand)) {
			const text = parsed.flags.has("stdin") ? stdin : parsed.positionals.find((token) => !token.startsWith("@"));
			if (text === undefined) return null;
			return ok(ffi.executeRef(ref, buildAction({ kind, text }), sessionId));
		}
		if (subcommand === "scroll") {
			const dirFlag = parsed.flags.get("direction");
			const direction = typeof dirFlag === "string" ? DIRECTIONS[dirFlag] : undefined;
			if (direction === undefined) return null;
			const amountFlag = parsed.flags.get("amount");
			const amount = typeof amountFlag === "string" ? Number.parseInt(amountFlag, 10) : 1;
			return ok(ffi.executeRef(ref, buildAction({ kind, direction, amount }), sessionId));
		}
		return null;
	} catch (error) {
		return fail(`agent-desktop ffi error: ${error instanceof Error ? error.message : String(error)}`);
	}
}
