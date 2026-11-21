/**
 * `_desktop` — Pizza's single CLI command for native desktop apps.
 *
 * The model calls this through the existing `cli` tool. Planning, retry,
 * pause, resume, and approval stay in Pizza. agent-desktop is only the
 * process that reads the accessibility tree and performs one action.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../../core/config/settings-manager.js";
import type { CliCommandDefinition, ExtensionContext } from "../../core/extensions/types.js";
import type { DesktopActionEvent } from "../../core/event-store/events.js";
import {
	checkRefFreshness,
	classifyDesktopCommand,
	collectElements,
	desktopError,
	DESKTOP_COMMAND_NAME,
	argsWithSurface,
	extractRefs,
	isBrowserPageRequest,
	isMutating,
	isRejectedCommand,
	needsDesktopSession,
	parseDesktopInvocation,
	platformCaveat,
	redactEnvelope,
	secretText,
	type DesktopParams,
} from "./policy.js";
import { parseEnvelope, runAgentDesktop, type DesktopEnvelope } from "./runner.js";
import {
	artifactDir,
	indexElements,
	loadDesktopSession,
	lookupRefNames,
	saveDesktopSession,
	threadBinding,
	updateDesktopSession,
	workspaceKey,
	type DesktopSessionRecord,
	type DesktopThreadBinding,
} from "./session.js";

export const AGENT_DESKTOP_EXTENSION_ID = "agent-desktop";

type DesktopAudit = DesktopActionEvent["payload"];

const PERMISSION_CACHE_MS = 30_000;

interface PermissionCache {
	at: number;
	accessibility: boolean;
	screen: boolean;
}

let permissionCache: PermissionCache | undefined;
let activeCwd: string | undefined;

export function setActiveDesktopCwd(cwd: string | undefined): void {
	activeCwd = cwd;
}

export function resetDesktopPermissionCache(): void {
	permissionCache = undefined;
}

export function isAgentDesktopEnabled(cwd: string): boolean {
	return !SettingsManager.create(cwd, getAgentDir()).getDisabledBuiltinExtensions().has(AGENT_DESKTOP_EXTENSION_ID);
}

function helpText(): string {
	const caveat = platformCaveat();
	return [
		"_desktop — observe and act on native desktop apps via agent-desktop",
		"",
		"Web pages stay on `_browser` (agent-browser). Do not use desktop",
		"accessibility to drive browser page content. macOS (Accessibility / AX)",
		"is the supported path. Windows (UI Automation) and Linux (AT-SPI) run",
		"the same commands with the platform limits below.",
		caveat ? `\n${caveat}\n` : "",
		"The CLI ships with Pizza and is on by default. Grant Accessibility before",
		"the first action (`/desktop permissions`).",
		"",
		"Loop: snapshot -> act on @<snapshot>:eN -> snapshot again.",
		"Refs belong to the current workspace and thread. After an action, or",
		"if the user takes over the computer, run `_desktop invalidate` or",
		"`_desktop snapshot` before using another ref.",
		"",
		"Observation:",
		"  _desktop snapshot --app Notes -i --compact",
		"  _desktop snapshot --root @s1:e1 -i --compact",
		"  _desktop find --app Notes --role button --name Save",
		"  _desktop get @s1:e1 --property value",
		"  _desktop is @s1:e1 --state enabled",
		"  _desktop screenshot --app Notes",
		"  _desktop list-apps | list-windows | list-displays | list-surfaces",
		"  _desktop wait --element @s1:e1 --predicate value --value Saved",
		"",
		"Actions:",
		"  _desktop click @s1:e1",
		"  _desktop type @s1:e2 \"hello\"",
		"  _desktop set-value @s1:e2 \"hello\"",
		"  _desktop press tab",
		"  _desktop launch Notes",
		"  _desktop focus-window --app Notes",
		"",
		"Send, pay, delete, quit, notification actions, and account changes",
		"wait for Pizza's approval dialog. Held keys (key-down/key-up) and",
		"`batch` are refused so each action stays inside that dialog.",
		"",
		"  _desktop invalidate     Drop this thread's snapshot",
		"  _desktop status         CLI, permission, and session status",
		"",
		"One durable desktop session is kept per workspace. Do not pass",
		"--session; Pizza binds it.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function threadIdFrom(ctx: ExtensionContext): string {
	const projection = (ctx.sessionManager as { projection?: { getDescriptor?: () => { thread_id?: string } } }).projection;
	const raw = projection?.getDescriptor?.().thread_id ?? "thread";
	const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
	return cleaned || "thread";
}

function audit(ctx: ExtensionContext, payload: DesktopAudit): void {
	const store = ctx.sessionManager?.eventStore;
	if (!store?.append) return;
	const threadId = threadIdFrom(ctx);
	const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)) as DesktopAudit;
	try {
		store.append({
			actor_id: "runtime",
			type: "DESKTOP_ACTION",
			payload: clean,
			thread_id: threadId,
		});
	} catch {
		// Audit must not hide the action result.
	}
}

function result(text: string, details: DesktopAudit) {
	return { content: [{ type: "text" as const, text }], details };
}

function blocked(ctx: ExtensionContext, command: string, code: string, message: string, outcome: DesktopAudit["outcome"] = "blocked") {
	const details: DesktopAudit = { action: command, outcome, reason: code };
	audit(ctx, details);
	return result(desktopError(command, code, message), details);
}

function accessibilityGranted(envelope: DesktopEnvelope | undefined): boolean {
	const permissions = envelope?.data?.permissions as { accessibility?: { state?: string } } | undefined;
	const direct = envelope?.data?.accessibility as { state?: string } | undefined;
	const state = direct?.state ?? permissions?.accessibility?.state;
	return state === "granted";
}

function screenGranted(envelope: DesktopEnvelope | undefined): boolean {
	const permissions = envelope?.data?.permissions as { screen_recording?: { state?: string } } | undefined;
	const direct = envelope?.data?.screen_recording as { state?: string } | undefined;
	const state = direct?.state ?? permissions?.screen_recording?.state;
	return state === "granted" || state === "not_required";
}

type PermissionRead = PermissionCache | { missing: true; message: string };

async function readPermissions(cwd: string, signal: AbortSignal | undefined): Promise<PermissionRead> {
	if (permissionCache && Date.now() - permissionCache.at < PERMISSION_CACHE_MS && permissionCache.accessibility) {
		return permissionCache;
	}
	const run = await runAgentDesktop(["permissions"], { cwd, signal, timeout: 20_000 });
	const envelope = parseEnvelope(run.stdout);
	if (!envelope) {
		const detail = run.stderr.trim();
		return {
			missing: true,
			message: `agent-desktop CLI is missing from this Pizza install or did not return JSON. Reinstall Pizza; a separate global install is not required.${detail ? ` ${detail}` : ""}`,
		};
	}
	const cache: PermissionCache = {
		at: Date.now(),
		accessibility: accessibilityGranted(envelope),
		screen: screenGranted(envelope),
	};
	if (cache.accessibility) permissionCache = cache;
	return cache;
}

function present(envelope: DesktopEnvelope, command: string, secret: string | undefined, artifact?: string): string {
	const redacted = redactEnvelope(envelope, secret) as DesktopEnvelope;
	if (command === "snapshot" || command === "find") {
		const data = (redacted.data ?? {}) as Record<string, unknown>;
		const elements = collectElements(data.tree ?? data.matches ?? data.match);
		const body: Record<string, unknown> = {
			ok: redacted.ok === true,
			command,
			app: data.app,
			snapshot_id: data.snapshot_id,
			ref_count: data.ref_count ?? elements.length,
			complete: data.complete,
			elements,
		};
		if (artifact) body.artifact = artifact;
		if (redacted.ok !== true && redacted.error) {
			body.error = { code: redacted.error.code, message: redacted.error.message };
		}
		return JSON.stringify(body, null, 2);
	}
	const data = (redacted.data ?? {}) as Record<string, unknown>;
	const disposition = data.disposition as { delivery?: string; retry?: string } | undefined;
	const body: Record<string, unknown> = {
		ok: redacted.ok === true,
		command,
	};
	if (typeof data.app === "string") body.app = data.app;
	if (typeof data.snapshot_id === "string") body.snapshot_id = data.snapshot_id;
	if (disposition?.delivery) body.delivery = disposition.delivery;
	if (disposition?.retry) body.retry = disposition.retry;
	if (artifact) body.artifact = artifact;
	if (typeof data.path === "string") body.artifact = data.path;
	if (redacted.ok !== true && redacted.error) {
		body.error = { code: redacted.error.code, message: redacted.error.message };
	}
	if (isMutating(command) && redacted.ok === true) {
		body.note = "Snapshot is now stale. Run _desktop snapshot before the next action.";
	}
	return JSON.stringify(body, null, 2);
}

function surfaceName(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--surface") return args[i + 1];
		if (token.startsWith("--surface=")) return token.slice("--surface=".length);
	}
	return undefined;
}

function applyObservation(binding: DesktopThreadBinding, envelope: DesktopEnvelope, surface: string | undefined): string | undefined {
	const data = envelope.data;
	if (!data?.snapshot_id || typeof data.snapshot_id !== "string") return undefined;
	const elements = collectElements(data.tree ?? data.matches ?? data.match);
	binding.snapshotId = data.snapshot_id;
	binding.spent = false;
	binding.app = typeof data.app === "string" ? data.app : binding.app;
	binding.surface = surface;
	binding.elements = indexElements(elements);
	return data.snapshot_id;
}

const SCREENSHOT_VALUE_FLAGS = new Set(["app", "window-id", "screen", "session", "agent-id", "timeout-ms"]);

function hasPositionalPath(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (!token.startsWith("--")) return true;
		const name = token.slice(2).split("=")[0]!;
		if (!token.includes("=") && SCREENSHOT_VALUE_FLAGS.has(name)) i++;
	}
	return false;
}

function timeoutFor(subcommand: string, args: string[]): number {
	let requested: number | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--timeout-ms" || token === "--wait-timeout") {
			const value = Number(args[i + 1]);
			if (Number.isFinite(value)) requested = value;
		}
	}
	if (subcommand === "wait") return Math.min(180_000, (requested ?? 30_000) + 15_000);
	if (subcommand === "snapshot" || subcommand === "find" || subcommand === "screenshot") return 90_000;
	return Math.min(120_000, (requested ?? 15_000) + 20_000);
}

async function ensureSession(cwd: string, signal: AbortSignal | undefined): Promise<{ record: DesktopSessionRecord; sessionId: string } | { error: string }> {
	return updateDesktopSession(cwd, async (record) => {
		if (record.sessionId) return { record, sessionId: record.sessionId };
		const name = `pizza-${record.workspaceKey.slice(0, 20)}`;
		const run = await runAgentDesktop(["session", "start", "--name", name, "--no-trace"], {
			cwd,
			signal,
			timeout: 20_000,
		});
		const envelope = parseEnvelope(run.stdout);
		const sessionId = envelope?.data?.session_id;
		if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
			return { error: envelope?.error?.message ?? (run.stderr.trim() || "agent-desktop session start failed") };
		}
		record.sessionId = sessionId;
		return { record, sessionId };
	});
}

function forgetSession(cwd: string): void {
	const record = loadDesktopSession(cwd);
	record.sessionId = undefined;
	record.threads = {};
	saveDesktopSession(record);
}

export const desktopBuiltinCommand: CliCommandDefinition<DesktopParams> = {
	name: DESKTOP_COMMAND_NAME,
	description: "Observe and act on native desktop apps (agent-desktop). Web pages use _browser.",
	usage: "_desktop <snapshot|click|type|press|...> [flags]",
	help: helpText(),
	executionMode: "sequential",
	promptGuidelines: [
		"Use _desktop for native desktop apps only. Web pages stay on _browser (agent-browser); never drive page content through desktop accessibility.",
		"Call _desktop snapshot, act on the returned @<snapshot>:eN refs, then snapshot again. Refs are bound to this workspace and thread and go stale after an action or when the user takes over.",
		"Send, pay, delete, quit, and account-setting actions wait for runtime approval. Do not batch desktop commands.",
	],
	isAvailable: () => isAgentDesktopEnabled(activeCwd ?? process.cwd()),
	unavailableReason:
		"agent-desktop is disabled or its CLI is missing. It ships with Pizza and is on by default; check /desktop status and Accessibility permission.",
	parseArguments(args, heredoc) {
		const params = parseDesktopInvocation(args, heredoc);
		params.targetNames = lookupRefNames(extractRefs(params.args));
		return params;
	},
	classify: classifyDesktopCommand,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const subcommand = params.subcommand.toLowerCase();
		if (subcommand === "help" || params.args.includes("--help") || params.args.includes("-h")) {
			return result(helpText(), { action: "help", outcome: "ok" });
		}
		if (!isAgentDesktopEnabled(ctx.cwd)) {
			return blocked(
				ctx,
				subcommand,
				"NOT_ENABLED",
				"agent-desktop is disabled. Re-enable with `pizza builtin enable agent-desktop`, then grant Accessibility (`/desktop permissions`) before use.",
			);
		}
		if (isRejectedCommand(subcommand)) {
			return blocked(
				ctx,
				subcommand,
				"INVALID_ARGS",
				`_desktop ${subcommand} is not available. Issue one action at a time so Pizza can approve it. Held keys and batch are refused.`,
			);
		}
		if (subcommand === "invalidate") {
			const threadId = threadIdFrom(ctx);
			await updateDesktopSession(ctx.cwd, (record) => {
				const binding = threadBinding(record, threadId);
				binding.snapshotId = undefined;
				binding.surface = undefined;
				binding.elements = {};
				binding.spent = false;
				binding.generation += 1;
			});
			const details: DesktopAudit = { action: "invalidate", outcome: "ok", reason: "user_or_agent_invalidation" };
			audit(ctx, details);
			return result(
				JSON.stringify({ ok: true, command: "invalidate", note: "Snapshot dropped. Run _desktop snapshot before the next action." }, null, 2),
				details,
			);
		}

		const threadId = threadIdFrom(ctx);
		const current = loadDesktopSession(ctx.cwd);
		const binding = current.threads[threadId];
		const requestArgs = argsWithSurface(params.args, binding?.surface);
		if (isBrowserPageRequest(subcommand, requestArgs, binding?.app)) {
			return blocked(
				ctx,
				subcommand,
				"WEB_PAGE",
				"That target is a web browser. Use _browser (agent-browser) for web pages. _desktop only drives native desktop apps. Menu bar, dock, and menu-bar extras are the exception.",
			);
		}

		const needsGrant = !["status", "permissions", "version", "skills", "help"].includes(subcommand);
		if (needsGrant) {
			const permissions = await readPermissions(ctx.cwd, signal);
			if ("missing" in permissions) {
				return blocked(ctx, subcommand, "CLI", permissions.message, "error");
			}
			if (!permissions.accessibility) {
				const caveat = platformCaveat();
				return blocked(
					ctx,
					subcommand,
					"PERM_DENIED",
					`Accessibility permission is not granted. On macOS run /desktop permissions (or \`agent-desktop permissions --guide\`) and enable Accessibility for the app that launches Pizza.${caveat ? ` ${caveat}` : ""}`,
				);
			}
			if (subcommand === "screenshot" && !permissions.screen) {
				return blocked(
					ctx,
					subcommand,
					"PERM_DENIED",
					"Screen Recording is not granted. Enable it for the app that launches Pizza, then retry _desktop screenshot.",
				);
			}
		}

		if (subcommand !== "snapshot" && subcommand !== "find") {
			const freshness = checkRefFreshness(subcommand, params.args, binding);
			if (!freshness.ok) {
				return blocked(ctx, subcommand, freshness.code ?? "STALE_REF", freshness.message ?? "Ref is stale.", freshness.code === "STALE_REF" ? "stale" : "blocked");
			}
		} else {
			const rooted = params.args.some((token, index) => token === "--root" || token.startsWith("--root=") || (index > 0 && params.args[index - 1] === "--root"));
			if (rooted) {
				const freshness = checkRefFreshness(subcommand, params.args, binding);
				if (!freshness.ok) {
					return blocked(ctx, subcommand, freshness.code ?? "STALE_REF", freshness.message ?? "Ref is stale.", "stale");
				}
			}
		}

		let sessionId: string | undefined;
		if (needsDesktopSession(subcommand)) {
			const ensured = await ensureSession(ctx.cwd, signal);
			if ("error" in ensured) {
				return blocked(ctx, subcommand, "SESSION", ensured.error, "error");
			}
			sessionId = ensured.sessionId;
		}

		const args = [...params.args];
		let artifact: string | undefined;
		if (subcommand === "screenshot" && !hasPositionalPath(args)) {
			mkdirSync(artifactDir(ctx.cwd), { recursive: true });
			artifact = join(artifactDir(ctx.cwd), `screen-${Date.now()}.png`);
			args.push(artifact);
		}
		if (sessionId) args.push("--session", sessionId);
		const secret = secretText(params.secretRef);
		if (secret !== undefined) args.push("--stdin");

		const runOnce = () =>
			runAgentDesktop([subcommand, ...args], {
				cwd: ctx.cwd,
				signal,
				timeout: timeoutFor(subcommand, args),
				input: secret,
			});

		let run = await runOnce();
		let envelope = parseEnvelope(run.stdout);
		if (envelope?.error?.details?.kind === "session_ended" && sessionId) {
			forgetSession(ctx.cwd);
			const retried = await ensureSession(ctx.cwd, signal);
			if (!("error" in retried)) {
				const rebound = args.map((token, index) => (args[index - 1] === "--session" ? retried.sessionId : token));
				sessionId = retried.sessionId;
				run = await runAgentDesktop([subcommand, ...rebound], {
					cwd: ctx.cwd,
					signal,
					timeout: timeoutFor(subcommand, rebound),
					input: secret,
				});
				envelope = parseEnvelope(run.stdout);
			}
		}

		if (!envelope) {
			const message = run.stderr.trim() || run.stdout.trim() || `agent-desktop exited ${run.code}. Reinstall Pizza if its bundled CLI is missing.`;
			return blocked(ctx, subcommand, "CLI", message, "error");
		}

		if ((subcommand === "snapshot" || subcommand === "find") && envelope.ok === true && isBrowserPageRequest(subcommand, requestArgs, typeof envelope.data?.app === "string" ? envelope.data.app : undefined)) {
			return blocked(
				ctx,
				subcommand,
				"WEB_PAGE",
				`Refusing to drive ${String(envelope.data?.app)} page content. Use _browser (agent-browser) for web pages.`,
			);
		}

		let snapshotId: string | undefined;
		if (envelope.ok === true && (subcommand === "snapshot" || subcommand === "find")) {
			mkdirSync(artifactDir(ctx.cwd), { recursive: true });
			snapshotId = typeof envelope.data?.snapshot_id === "string" ? envelope.data.snapshot_id : undefined;
			if (snapshotId) {
				artifact = join(artifactDir(ctx.cwd), `${snapshotId}.json`);
				const stored = redactEnvelope(envelope, secret);
				writeFileSync(artifact, `${JSON.stringify(stored, null, 2)}\n`);
			}
			await updateDesktopSession(ctx.cwd, (record) => {
				const next = threadBinding(record, threadId);
				applyObservation(next, envelope!, surfaceName(requestArgs));
			});
		} else if (envelope.ok === true && isMutating(subcommand)) {
			await updateDesktopSession(ctx.cwd, (record) => {
				const next = threadBinding(record, threadId);
				if (next.snapshotId) next.spent = true;
			});
		} else if (envelope.ok !== true && (envelope.error?.code === "STALE_REF" || envelope.error?.code === "SNAPSHOT_NOT_FOUND")) {
			await updateDesktopSession(ctx.cwd, (record) => {
				const next = threadBinding(record, threadId);
				next.snapshotId = undefined;
				next.surface = undefined;
				next.elements = {};
				next.spent = false;
			});
		}

		const refs = extractRefs(params.args);
		const details: DesktopAudit = {
			action: subcommand,
			outcome: envelope.ok === true ? "ok" : envelope.error?.code === "STALE_REF" ? "stale" : "error",
			app: typeof envelope.data?.app === "string" ? envelope.data.app : binding?.app,
			snapshot_id: snapshotId ?? (typeof envelope.data?.snapshot_id === "string" ? envelope.data.snapshot_id : binding?.snapshotId),
			ref: refs[0],
			artifact,
			reason: envelope.ok === true ? undefined : envelope.error?.code,
			session_id: sessionId,
		};
		audit(ctx, details);
		let text = present(envelope, subcommand, secret, artifact);
		const caveat = platformCaveat();
		if (subcommand === "status" && caveat) {
			const body = JSON.parse(text) as Record<string, unknown>;
			body.platform_note = caveat;
			text = JSON.stringify(body, null, 2);
		}
		return result(text, details);
	},
};

export function desktopWorkspaceKey(cwd: string): string {
	return workspaceKey(cwd);
}
