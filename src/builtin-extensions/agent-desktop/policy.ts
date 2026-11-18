/**
 * Pure policy for the agent-desktop execution layer.
 *
 * Pizza keeps the decisions: which commands exist, which ones need a fresh
 * snapshot, which ones are irreversible, and which targets are web pages.
 * agent-desktop stays a CLI that returns one JSON envelope.
 */

import type { ToolCallIntent } from "../../core/intent/types.js";
import { splitShellWords } from "../../core/exec/shell-words.js";
import { peekSecret, stashSecret } from "./secrets.js";

export const DESKTOP_COMMAND_NAME = "_desktop";

/** Commands that read or wait. They do not mark the current snapshot spent. */
const OBSERVATION = new Set([
	"snapshot",
	"find",
	"get",
	"is",
	"screenshot",
	"list-apps",
	"list-windows",
	"list-displays",
	"list-surfaces",
	"list-notifications",
	"status",
	"permissions",
	"version",
	"skills",
	"wait",
	"help",
	"invalidate",
	"clipboard-get",
]);

/**
 * Commands that change the desktop. After one of them succeeds, element refs
 * from the current snapshot are spent and must not be reused.
 */
const MUTATING = new Set([
	"click",
	"double-click",
	"triple-click",
	"right-click",
	"type",
	"set-value",
	"clear",
	"focus",
	"select",
	"toggle",
	"check",
	"uncheck",
	"expand",
	"collapse",
	"scroll",
	"scroll-to",
	"hover",
	"drag",
	"press",
	"mouse-move",
	"mouse-click",
	"mouse-wheel",
	"launch",
	"close-app",
	"focus-window",
	"resize-window",
	"move-window",
	"minimize",
	"maximize",
	"restore",
	"open-system-surface",
	"dismiss-notification",
	"dismiss-all-notifications",
	"notification-action",
	"clipboard-set",
	"clipboard-clear",
]);

/** Commands whose target is an element ref from the current snapshot. */
const ELEMENT_COMMANDS = new Set([
	"click",
	"double-click",
	"triple-click",
	"right-click",
	"type",
	"set-value",
	"clear",
	"focus",
	"select",
	"toggle",
	"check",
	"uncheck",
	"expand",
	"collapse",
	"scroll",
	"scroll-to",
	"hover",
	"drag",
	"get",
	"is",
	"wait",
]);

/** Refused outright. batch would skip per-command approval; held input fails closed upstream. */
const REJECTED = new Set([
	"batch",
	"session",
	"sandbox",
	"trace",
	"cursor-overlay",
	"key-down",
	"key-up",
	"mouse-down",
	"mouse-up",
]);

const SECRET_COMMANDS = new Set(["type", "set-value", "clipboard-set"]);

const NO_SESSION = new Set(["help", "permissions", "version", "skills", "status", "invalidate"]);

/** Flags Pizza owns. The model cannot point a command at another session or trace. */
const STRIPPED_FLAGS = new Set(["session", "agent-id", "trace", "trace-strict", "force"]);
const STRIPPED_BOOLEAN = new Set(["trace-strict", "force"]);

const DESTRUCTIVE_COMMANDS = new Set([
	"close-app",
	"dismiss-notification",
	"dismiss-all-notifications",
	"notification-action",
]);

const DESTRUCTIVE_KEYS = new Set([
	"return",
	"enter",
	"cmd+enter",
	"cmd+return",
	"ctrl+enter",
	"ctrl+return",
	"control+enter",
	"control+return",
	"cmd+q",
	"alt+f4",
	"cmd+w",
	"ctrl+w",
	"control+w",
	"cmd+delete",
	"cmd+backspace",
]);

const DESTRUCTIVE_NAME =
	/\b(send|pay|paid|purchase|buy|checkout|delete|remove|erase|logout|log out|sign out|signout|transfer|subscribe|unsubscribe|deactivate)\b|place order|confirm payment|change password|delete account|close account|account settings/i;

const BROWSER_APPS = new Set([
	"safari",
	"google chrome",
	"chrome",
	"chromium",
	"google chrome canary",
	"firefox",
	"firefox developer edition",
	"microsoft edge",
	"edge",
	"arc",
	"brave",
	"brave browser",
	"opera",
	"vivaldi",
	"webkit",
	"orion",
	"com.apple.safari",
	"com.google.chrome",
	"com.microsoft.edgemac",
	"com.microsoft.edge",
	"org.mozilla.firefox",
]);

/** Shell surfaces that are not web page content, even when the app is a browser. */
const CHROME_SURFACES = new Set(["menubar", "menu", "dock", "menu-bar-extras"]);

const REF_RE = /@[A-Za-z0-9]+:e\d+/g;

export interface DesktopParams {
	subcommand: string;
	/** Arguments with secrets and stripped control flags removed. */
	args: string[];
	/** Handle for text held outside the event log. */
	secretRef?: number;
	/** Accessible names of the targeted refs, when this workspace has indexed them. */
	targetNames: string[];
}

export interface RefFreshness {
	ok: boolean;
	code?: "STALE_REF" | "WEB_PAGE";
	message?: string;
}

export function isObservation(subcommand: string): boolean {
	return OBSERVATION.has(subcommand);
}

export function isMutating(subcommand: string): boolean {
	return MUTATING.has(subcommand);
}

export function needsDesktopSession(subcommand: string): boolean {
	return !NO_SESSION.has(subcommand);
}

export function isRejectedCommand(subcommand: string): boolean {
	return REJECTED.has(subcommand);
}

export function extractRefs(args: readonly string[]): string[] {
	const refs: string[] = [];
	for (const token of args) {
		const matches = token.match(REF_RE);
		if (matches) refs.push(...matches);
	}
	return refs;
}

export function snapshotIdOfRef(ref: string): string | undefined {
	const match = /^@([A-Za-z0-9]+):e\d+$/.exec(ref);
	return match?.[1];
}

export function isBrowserApp(name: string | undefined): boolean {
	if (!name) return false;
	return BROWSER_APPS.has(name.trim().toLowerCase());
}

export function isWebRole(role: string | undefined): boolean {
	if (!role) return false;
	return /webarea|axwebarea|^web$|^html$/i.test(role.trim());
}

export function isDestructiveName(name: string | undefined): boolean {
	if (!name) return false;
	return DESTRUCTIVE_NAME.test(name);
}

function flagValue(args: readonly string[], name: string): string | undefined {
	const exact = `--${name}`;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === exact) return args[i + 1];
		if (token.startsWith(`${exact}=`)) return token.slice(exact.length + 1);
	}
	return undefined;
}

/** Carry a snapshot's surface onto a later ref action that does not repeat `--surface`. */
export function argsWithSurface(args: readonly string[], surface: string | undefined): string[] {
	if (!surface || flagValue(args, "surface")) return [...args];
	return [...args, "--surface", surface];
}

/** Browser window content stays on `_browser`. Menu-bar and dock surfaces are not page content. */
export function isBrowserPageRequest(subcommand: string, args: readonly string[], boundApp?: string): boolean {
	if (NO_SESSION.has(subcommand) || subcommand === "launch" || subcommand === "list-apps" || subcommand === "list-windows" || subcommand === "close-app") {
		return false;
	}
	const surface = flagValue(args, "surface");
	if (surface && CHROME_SURFACES.has(surface.trim().toLowerCase())) return false;
	const app = flagValue(args, "app") ?? boundApp;
	return isBrowserApp(app);
}

export function pressKey(args: readonly string[]): string | undefined {
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--") continue;
		if (token.startsWith("--")) {
			const name = token.slice(2).split("=")[0]!;
			if (!token.includes("=") && !STRIPPED_BOOLEAN.has(name) && name !== "headed" && name !== "verbose" && name !== "force") {
				i++;
			}
			continue;
		}
		positionals.push(token);
	}
	return positionals[0]?.toLowerCase();
}

export function classifyDesktopCommand(params: DesktopParams): ToolCallIntent {
	const sub = params.subcommand.toLowerCase();
	const target = params.targetNames.find((name) => name.trim() !== "");
	const description = target ? `Desktop ${sub} on ${target}` : `Desktop ${sub}`;
	if (isDestructiveAction(sub, params)) {
		return {
			category: "shell_dangerous",
			forceApproval: true,
			description: `${description} needs confirmation`,
		};
	}
	if (isObservation(sub)) {
		return { category: "shell_safe", description };
	}
	return { category: "shell_moderate", description };
}

export function isDestructiveAction(subcommand: string, params: Pick<DesktopParams, "args" | "targetNames">): boolean {
	if (DESTRUCTIVE_COMMANDS.has(subcommand)) return true;
	if (subcommand === "press") {
		const key = pressKey(params.args);
		if (key && DESTRUCTIVE_KEYS.has(key)) return true;
	}
	return params.targetNames.some((name) => isDestructiveName(name));
}

/**
 * Decide whether a ref may be used.
 *
 * `spent` means a mutating command already ran against this snapshot, so the
 * UI may have changed. Reads (`get`, `is`, `wait`) may still use it once.
 * Another mutation, or a ref from a different snapshot, is refused.
 */
export function checkRefFreshness(
	subcommand: string,
	args: readonly string[],
	binding: { snapshotId?: string; spent?: boolean; elements?: Record<string, { role?: string }> } | undefined,
): RefFreshness {
	const refs = extractRefs(args);
	const rooted = subcommand === "snapshot" || subcommand === "find" ? flagValue(args, "root") : undefined;
	const rootedRefs = rooted ? extractRefs([rooted]) : [];
	const allRefs = [...refs, ...rootedRefs];
	const needsRef = ELEMENT_COMMANDS.has(subcommand) || rootedRefs.length > 0;
	const blindMutation = (subcommand === "press" || subcommand.startsWith("mouse-")) && allRefs.length === 0;

	if (!needsRef && !blindMutation) return { ok: true };
	if (!binding?.snapshotId) {
		return {
			ok: false,
			code: "STALE_REF",
			message: "No snapshot for this workspace and thread. Run _desktop snapshot, then use the refs it returns.",
		};
	}
	for (const ref of allRefs) {
		const snapshotId = snapshotIdOfRef(ref);
		if (!snapshotId || snapshotId !== binding.snapshotId) {
			return {
				ok: false,
				code: "STALE_REF",
				message: `Ref ${ref} is not from the current snapshot (${binding.snapshotId}) for this thread. Run _desktop snapshot again and use the new refs.`,
			};
		}
		const role = binding.elements?.[ref]?.role;
		if (isWebRole(role)) {
			return {
				ok: false,
				code: "WEB_PAGE",
				message: `Ref ${ref} is web page content. Use _browser (agent-browser) for web pages; _desktop is for native desktop apps.`,
			};
		}
	}
	if (binding.spent && isMutating(subcommand)) {
		return {
			ok: false,
			code: "STALE_REF",
			message: "The current snapshot was already used for an action. Run _desktop snapshot again before the next action.",
		};
	}
	return { ok: true };
}

export function stripOwnedFlags(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (!token.startsWith("--")) {
			out.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = token.slice(2, eq === -1 ? undefined : eq);
		if (!STRIPPED_FLAGS.has(name)) {
			out.push(token);
			continue;
		}
		if (eq === -1 && !STRIPPED_BOOLEAN.has(name)) i++;
	}
	return out;
}

function quoteWord(word: string): string {
	if (word === "") return "''";
	if (/[\s'"\\$`|&;<>(){}]/.test(word)) return `'${word.replace(/'/g, `'\\''`)}'`;
	return word;
}

/**
 * Pull typed text out of a type / set-value / clipboard-set invocation.
 * The returned args are safe to log. The text itself is only available
 * through the secret handle.
 */
export function consumeSecretArgs(
	subcommand: string,
	args: string[],
	heredoc?: string,
): { args: string[]; secretRef?: number } {
	if (!SECRET_COMMANDS.has(subcommand)) return { args: stripOwnedFlags(args) };
	const kept: string[] = [];
	let secret: string | undefined;
	let secretRef: number | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--secret-ref") {
			const id = Number(args[++i]);
			if (Number.isInteger(id)) secretRef = id;
			continue;
		}
		if (token.startsWith("--secret-ref=")) {
			const id = Number(token.slice("--secret-ref=".length));
			if (Number.isInteger(id)) secretRef = id;
			continue;
		}
		if (token === "--text" || token === "--value") {
			secret = args[++i] ?? "";
			continue;
		}
		if (token.startsWith("--text=") || token.startsWith("--value=")) {
			secret = token.slice(token.indexOf("=") + 1);
			continue;
		}
		kept.push(token);
	}
	if (heredoc !== undefined && secret === undefined && secretRef === undefined) secret = heredoc;
	if (secret === undefined && secretRef === undefined) {
		const stripped = stripOwnedFlags(kept);
		const positionals: string[] = [];
		const flags: string[] = [];
		for (let i = 0; i < stripped.length; i++) {
			const token = stripped[i]!;
			if (token.startsWith("--")) {
				flags.push(token);
				const name = token.slice(2).split("=")[0]!;
				const booleanFlag = token.includes("=") || name === "stdin" || name === "headed" || name === "verbose" || name === "image" || name === "file-url";
				if (!booleanFlag && name !== "image" && name !== "file-url" && !token.includes("=")) {
					const next = stripped[i + 1];
					if (next !== undefined && !next.startsWith("--")) {
						flags.push(next);
						i++;
					}
				}
				continue;
			}
			positionals.push(token);
		}
		if (subcommand === "clipboard-set") {
			if (positionals.length > 0 && !flags.some((flag) => flag === "--image" || flag.startsWith("--image=") || flag === "--file-url" || flag.startsWith("--file-url="))) {
				secret = positionals.join(" ");
				return { args: flags, secretRef: stashSecret(secret) };
			}
			return { args: stripOwnedFlags(kept) };
		}
		const ref = positionals.find((token) => token.startsWith("@"));
		const textParts = positionals.filter((token) => token !== ref);
		if (textParts.length > 0) {
			secret = textParts.join(" ");
			const rest = [...flags];
			if (ref) rest.unshift(ref);
			return { args: stripOwnedFlags(rest), secretRef: stashSecret(secret) };
		}
		return { args: stripOwnedFlags(kept) };
	}
	if (secret !== undefined && secretRef === undefined) secretRef = stashSecret(secret);
	return { args: stripOwnedFlags(kept), secretRef };
}

/** Replace secret text in a raw `_desktop` command before it is logged. Idempotent. */
export function redactDesktopCommandLine(command: string): string {
	const trimmed = command.trim();
	if (!trimmed.startsWith(`${DESKTOP_COMMAND_NAME} `) || trimmed.includes("--secret-ref")) return command;
	const heredoc = trimmed.match(/^(.*?)\s+<<\s*(['"]?)(\w+)\2\s*\n([\s\S]*)\n\3\s*$/);
	const prefix = heredoc ? (heredoc[1] ?? "").trim() : trimmed;
	const words = splitShellWords(prefix);
	if (words[0] !== DESKTOP_COMMAND_NAME) return command;
	const sub = (words[1] ?? "").toLowerCase();
	if (!SECRET_COMMANDS.has(sub)) return command;
	const consumed = consumeSecretArgs(sub, words.slice(2), heredoc?.[4]);
	if (consumed.secretRef === undefined) return command;
	return [...words.slice(0, 2), ...consumed.args, "--secret-ref", String(consumed.secretRef)].map(quoteWord).join(" ");
}

export function parseDesktopInvocation(args: string[], heredoc?: string): DesktopParams {
	const first = args[0]?.toLowerCase();
	const subcommand = first && first !== "--help" && first !== "-h" ? first : "help";
	const consumed = consumeSecretArgs(subcommand, args.slice(subcommand === "help" ? 0 : 1), heredoc);
	return {
		subcommand,
		args: consumed.args,
		secretRef: consumed.secretRef,
		targetNames: [],
	};
}

export function secretText(secretRef: number | undefined): string | undefined {
	if (secretRef === undefined) return undefined;
	return peekSecret(secretRef);
}

const SECRET_KEY = /password|token|cookie|authorization|secret|api[-_]?key/i;

/** Drop secrets, image bytes, and vendor-only bulk from an envelope before it is shown or stored. */
export function redactEnvelope(value: unknown, secret?: string): unknown {
	if (typeof value === "string") {
		if (secret && secret.length > 0 && value.includes(secret)) return value.split(secret).join("[redacted]");
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => redactEnvelope(item, secret));
	if (!value || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(source)) {
		if (key === "data" && typeof inner === "string" && inner.length > 256) continue;
		if (typeof inner === "string" && SECRET_KEY.test(key)) {
			out[key] = "[redacted]";
			continue;
		}
		out[key] = redactEnvelope(inner, secret);
	}
	if (typeof out.name === "string" && SECRET_KEY.test(out.name) && typeof out.value === "string") {
		out.value = "[redacted]";
	}
	return out;
}

export interface CompactElement {
	ref_id: string;
	role?: string;
	name?: string;
	value?: string;
}

export function collectElements(node: unknown, out: CompactElement[] = [], limit = 400): CompactElement[] {
	if (!node || typeof node !== "object" || out.length >= limit) return out;
	const record = node as Record<string, unknown>;
	if (typeof record.ref_id === "string") {
		const element: CompactElement = { ref_id: record.ref_id };
		if (typeof record.role === "string") element.role = record.role;
		if (typeof record.name === "string") element.name = record.name;
		if (typeof record.value === "string" && !isWebRole(element.role) && !SECRET_KEY.test(element.name ?? "") && !SECRET_KEY.test(element.role ?? "")) {
			element.value = record.value.length > 200 ? `${record.value.slice(0, 200)}…` : record.value;
		}
		out.push(element);
	}
	const children = record.children;
	if (Array.isArray(children)) {
		for (const child of children) collectElements(child, out, limit);
	}
	const matches = record.matches;
	if (Array.isArray(matches)) {
		for (const match of matches) collectElements(match, out, limit);
	}
	return out;
}

export function desktopError(command: string, code: string, message: string): string {
	return JSON.stringify({ ok: false, command, error: { code, message } }, null, 2);
}

export function platformCaveat(platform = process.platform): string | undefined {
	if (platform === "darwin") return undefined;
	if (platform === "win32") {
		return "Windows is not the primary path. agent-desktop uses UI Automation on Windows 10 1809+ in the signed-in interactive desktop. There is no Accessibility grant dialog; an elevated app cannot be driven from a lower-integrity terminal (UIPI). The binary is unsigned.";
	}
	if (platform === "linux") {
		return "Linux is not the primary path. agent-desktop uses AT-SPI on Ubuntu 24.04+ (glibc 2.35) inside the signed-in graphical session. There is no macOS-style permission dialog; an empty supported_surfaces list means the accessibility bus did not answer. Wayland pointer actions are limited.";
	}
	return `agent-desktop has no adapter for platform '${platform}'.`;
}
