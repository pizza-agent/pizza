/**
 * Desktop workflow capsules: record `_computer_use act` steps, save them as a
 * reusable JSON capsule, and replay them against a fresh observation.
 *
 * Refs (`@e12`) are ephemeral. Recording resolves each ref to a stable
 * role/title/identifier selector; replay searches the current outline for that
 * selector and substitutes a fresh ref before calling act_ui again.
 */

import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import type { ExtensionContext } from "../../core/extensions/types.js";
import type { ActParams, UiAction, UiCondition } from "./backend/contract.js";
import { executeAct, executeInspectUi, executeSearchUi } from "./backend/bridge.js";

export interface CapsuleSelector {
	role: string;
	title: string;
	identifier: string;
	description: string;
}

export interface CapsuleAction extends Omit<UiAction, "ref"> {
	ref?: string;
	selector?: CapsuleSelector;
}

export interface CapsuleExpect extends Omit<UiCondition, "ref" | "scopeRef"> {
	selector?: CapsuleSelector;
	scopeSelector?: CapsuleSelector;
	/** Raw refs are only kept as a best-effort fallback when inspection fails. */
	ref?: string;
	scopeRef?: string;
}

export interface CapsuleStep {
	actions: CapsuleAction[];
	expect?: CapsuleExpect;
}

export interface Capsule {
	version: 1;
	name: string;
	createdAt: number;
	updatedAt: number;
	steps: CapsuleStep[];
}

interface Recording {
	name: string;
	startedAt: number;
	steps: CapsuleStep[];
}

interface SearchMatch {
	ref: string;
	role: string;
	label: string;
	path?: string;
}

export interface CapsuleExecutors {
	search: typeof executeSearchUi;
	act: typeof executeAct;
	inspect: typeof executeInspectUi;
}

const DEFAULT_EXECUTORS: CapsuleExecutors = {
	search: executeSearchUi,
	act: executeAct,
	inspect: executeInspectUi,
};

const recordings = new Map<string, Recording>();
const CAPSULE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function sessionKey(ctx: ExtensionContext): string {
	const descriptor = ctx.sessionManager.projection?.getDescriptor();
	return descriptor?.session_id ?? ctx.cwd;
}

function capsuleDir(): string {
	return join(getAgentDir(), "desktop-capsules");
}

function capsulePath(name: string): string {
	return join(capsuleDir(), `${name}.json`);
}

function assertName(name: string): void {
	if (!CAPSULE_NAME.test(name)) {
		throw new Error(
			`Invalid capsule name "${name}". Use 1-64 letters, digits, dot, underscore or dash.`,
		);
	}
}

function selectorFromNode(node: unknown): CapsuleSelector | undefined {
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	const role = typeof record.role === "string" ? record.role : "";
	const title = typeof record.title === "string" ? record.title : "";
	const identifier = typeof record.identifier === "string" ? record.identifier : "";
	const description = typeof record.description === "string" ? record.description : "";
	if (!role && !title && !identifier && !description) return undefined;
	return { role, title, identifier, description };
}

function getInspectTarget(details: unknown): unknown {
	return details && typeof details === "object" ? (details as { target?: unknown }).target : undefined;
}

function getSearchMatches(details: unknown): SearchMatch[] {
	const matches = details && typeof details === "object" ? (details as { matches?: unknown }).matches : undefined;
	return Array.isArray(matches) ? (matches as SearchMatch[]) : [];
}

function selectMatch(matches: SearchMatch[], selector: CapsuleSelector): SearchMatch | undefined {
	const scored = matches
		.map((match) => {
			let score = 0;
			if (selector.role && match.role === selector.role) score += 3;
			if (selector.title && match.label === selector.title) score += 5;
			else if (selector.title && match.label.includes(selector.title)) score += 2;
			if (selector.identifier && match.path?.includes(selector.identifier)) score += 2;
			if (selector.description && match.label.includes(selector.description)) score += 1;
			return { match, score };
		})
		.sort((a, b) => b.score - a.score);
	return scored[0]?.score > 0 ? scored[0].match : undefined;
}

async function resolveSelector(
	ctx: ExtensionContext,
	stateId: string,
	selector: CapsuleSelector,
	executors: CapsuleExecutors,
): Promise<string> {
	const text = selector.title || selector.identifier || selector.description;
	const params: Record<string, unknown> = { stateId };
	if (text) params.text = text;
	if (selector.role) params.role = selector.role;
	if (!text && !selector.role) {
		throw new Error("Capsule selector has neither title nor role; cannot resolve it.");
	}
	const result = await executors.search("capsule_resolve", params as never, undefined, undefined, ctx);
	const matches = getSearchMatches(result.details);
	const match = selectMatch(matches, selector);
	if (!match) {
		throw new Error(
			`Capsule selector not found: ${selector.role} ${JSON.stringify(selector.title || selector.identifier || selector.description)}`,
		);
	}
	return match.ref;
}

async function captureExpect(
	ctx: ExtensionContext,
	stateId: string | undefined,
	expect: UiCondition | undefined,
	executors: CapsuleExecutors,
): Promise<CapsuleExpect | undefined> {
	if (!expect) return undefined;
	const { ref, scopeRef, ...rest } = expect;
	const captured: CapsuleExpect = { ...rest };
	if (ref) {
		if (stateId) {
			try {
				const inspected = await executors.inspect("capsule_record_expect", { stateId, ref } as never, undefined, undefined, ctx);
				captured.selector = selectorFromNode(getInspectTarget(inspected.details));
			} catch {
				// fall through to the raw ref
			}
		}
		if (!captured.selector) captured.ref = ref;
	}
	if (scopeRef) {
		if (stateId) {
			try {
				const inspected = await executors.inspect("capsule_record_scope", { stateId, ref: scopeRef } as never, undefined, undefined, ctx);
				captured.scopeSelector = selectorFromNode(getInspectTarget(inspected.details));
			} catch {
				// fall through to the raw ref
			}
		}
		if (!captured.scopeSelector) captured.scopeRef = scopeRef;
	}
	return captured;
}

async function resolveExpect(
	ctx: ExtensionContext,
	stateId: string,
	expect: CapsuleExpect | undefined,
	executors: CapsuleExecutors,
): Promise<UiCondition | undefined> {
	if (!expect) return undefined;
	const { selector, scopeSelector, ...rest } = expect;
	const resolved: UiCondition = { ...rest };
	if (rest.ref && !selector) {
		throw new Error(
			`Capsule expect ref "${rest.ref}" has no selector; re-observe and re-record this capsule.`,
		);
	}
	if (rest.scopeRef && !scopeSelector) {
		throw new Error(
			`Capsule expect scopeRef "${rest.scopeRef}" has no selector; re-observe and re-record this capsule.`,
		);
	}
	if (selector) resolved.ref = await resolveSelector(ctx, stateId, selector, executors);
	if (scopeSelector) resolved.scopeRef = await resolveSelector(ctx, stateId, scopeSelector, executors);
	return resolved;
}

/** Start recording an act sequence for the current session. */
export function startRecording(ctx: ExtensionContext, name: string): void {
	assertName(name);
	const key = sessionKey(ctx);
	if (recordings.has(key)) {
		throw new Error("A capsule is already being recorded in this session. Use _capsule stop or _capsule cancel first.");
	}
	recordings.set(key, { name, startedAt: Date.now(), steps: [] });
}

export function recordingName(ctx: ExtensionContext): string | undefined {
	return recordings.get(sessionKey(ctx))?.name;
}

/** Append one `_computer_use act` argument set while recording. */
export async function recordAct(
	ctx: ExtensionContext,
	params: ActParams,
	executors: CapsuleExecutors = DEFAULT_EXECUTORS,
): Promise<void> {
	const recording = recordings.get(sessionKey(ctx));
	if (!recording) return;
	const stateId = typeof params.stateId === "string" ? params.stateId : undefined;
	const actions: CapsuleAction[] = [];
	for (const action of params.actions ?? []) {
		let selector: CapsuleSelector | undefined;
		if (action.ref && stateId) {
			try {
				const inspected = await executors.inspect(
					"capsule_record",
					{ stateId, ref: action.ref } as never,
					undefined,
					undefined,
					ctx,
				);
				selector = selectorFromNode(getInspectTarget(inspected.details));
			} catch {
				// Keep the raw ref as a best-effort fallback; replay will fail
				// loudly if the ref is stale rather than silently clicking.
			}
		}
		actions.push({ ...action, ...(selector ? { selector } : {}) });
	}
	const expect = await captureExpect(ctx, stateId, params.expect, executors);
	recording.steps.push({
		actions,
		...(expect ? { expect } : {}),
	});
}

/** Finish recording and persist the capsule. */
export async function stopRecording(ctx: ExtensionContext): Promise<Capsule> {
	const key = sessionKey(ctx);
	const recording = recordings.get(key);
	if (!recording) throw new Error("No capsule recording is active in this session.");
	if (recording.steps.length === 0) {
		recordings.delete(key);
		throw new Error("Recording contains no steps; nothing was saved.");
	}
	const capsule: Capsule = {
		version: 1,
		name: recording.name,
		createdAt: recording.startedAt,
		updatedAt: Date.now(),
		steps: recording.steps,
	};
	await mkdir(capsuleDir(), { recursive: true });
	const path = capsulePath(capsule.name);
	await writeFile(path, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");
	await chmod(path, 0o600).catch(() => {});
	recordings.delete(key);
	return capsule;
}

export function cancelRecording(ctx: ExtensionContext): void {
	recordings.delete(sessionKey(ctx));
}

export async function loadCapsule(name: string): Promise<Capsule> {
	assertName(name);
	const raw = await readFile(capsulePath(name), "utf8");
	const parsed = JSON.parse(raw) as Capsule;
	if (parsed.version !== 1 || !Array.isArray(parsed.steps)) {
		throw new Error(`Capsule "${name}" has an unsupported format.`);
	}
	return parsed;
}

export async function listCapsules(): Promise<Array<Pick<Capsule, "name" | "createdAt" | "updatedAt"> & { steps: number }>> {
	await mkdir(capsuleDir(), { recursive: true });
	const files = (await readdir(capsuleDir())).filter((file) => file.endsWith(".json")).sort();
	const out = [];
	for (const file of files) {
		try {
			const capsule = JSON.parse(await readFile(join(capsuleDir(), file), "utf8")) as Capsule;
			if (capsule.version !== 1 || !Array.isArray(capsule.steps)) continue;
			out.push({ name: capsule.name, createdAt: capsule.createdAt, updatedAt: capsule.updatedAt, steps: capsule.steps.length });
		} catch {
			// Ignore a corrupt capsule rather than making `list` unusable.
		}
	}
	return out;
}

export async function deleteCapsule(name: string): Promise<void> {
	assertName(name);
	await rm(capsulePath(name), { force: true });
}

/**
 * Replay a capsule against an existing observation.
 *
 * The caller must `_computer_use observe` first (or otherwise provide a live
 * stateId); the capsule resolves each selector against that outline and
 * carries the successor stateId through the steps.
 */
export async function playCapsule(
	ctx: ExtensionContext,
	name: string,
	stateId: string,
	executors: CapsuleExecutors = DEFAULT_EXECUTORS,
): Promise<{ steps: number; finalStateId: string; capsule: Capsule }> {
	const capsule = await loadCapsule(name);
	let currentStateId = stateId;
	for (let i = 0; i < capsule.steps.length; i++) {
		const step = capsule.steps[i];
		const actions: UiAction[] = [];
		for (const action of step.actions) {
			if (!action.selector) {
				if (action.ref) {
					throw new Error(
						`Capsule step ${i + 1} has an unresolved ref "${action.ref}"; re-observe and re-record this capsule.`,
					);
				}
				actions.push(action as UiAction);
				continue;
			}
			const ref = await resolveSelector(ctx, currentStateId, action.selector, executors);
			const { selector: _selector, ...rest } = action;
			actions.push({ ...(rest as UiAction), ref });
		}
		const expect = await resolveExpect(ctx, currentStateId, step.expect, executors);
		const result = await executors.act(
			"capsule_play",
			{ stateId: currentStateId, actions, ...(expect ? { expect } : {}) } as never,
			undefined,
			undefined,
			ctx,
		);
		const next = (result.details as { capture?: { stateId?: unknown } } | undefined)?.capture?.stateId;
		if (typeof next === "string" && next.length > 0) currentStateId = next;
	}
	return { steps: capsule.steps.length, finalStateId: currentStateId, capsule };
}
