/**
 * One durable agent-desktop session per workspace.
 *
 * The session id is created on the first command that needs it and reused
 * after that. Element refs are bound to the thread that captured them.
 * A different workspace or thread never inherits those refs.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import type { CompactElement } from "./policy.js";

export interface DesktopElementRecord {
	name?: string;
	role?: string;
	web?: boolean;
}

export interface DesktopThreadBinding {
	generation: number;
	snapshotId?: string;
	spent: boolean;
	app?: string;
	/** Surface that produced the current snapshot, such as `menubar` or `dock`. */
	surface?: string;
	elements: Record<string, DesktopElementRecord>;
}

export interface DesktopSessionRecord {
	version: 1;
	workspaceKey: string;
	cwd: string;
	sessionId?: string;
	threads: Record<string, DesktopThreadBinding>;
}

const chains = new Map<string, Promise<unknown>>();

export function workspaceKey(cwd: string): string {
	let resolved = cwd;
	try {
		resolved = realpathSync(cwd);
	} catch {
		// The directory may not exist yet in tests. The path string is still a stable key.
	}
	return createHash("sha256").update(resolved).digest("hex").slice(0, 32);
}

export function sessionFilePath(cwd: string): string {
	return join(getAgentDir(), "desktop-sessions", `${workspaceKey(cwd)}.json`);
}

export function artifactDir(cwd: string): string {
	return join(getAgentDir(), "desktop-artifacts", workspaceKey(cwd));
}

function blankThread(): DesktopThreadBinding {
	return { generation: 1, spent: false, elements: {} };
}

function blankRecord(cwd: string): DesktopSessionRecord {
	return { version: 1, workspaceKey: workspaceKey(cwd), cwd, threads: {} };
}

export function loadDesktopSession(cwd: string): DesktopSessionRecord {
	try {
		const parsed = JSON.parse(readFileSync(sessionFilePath(cwd), "utf8")) as DesktopSessionRecord;
		if (parsed?.version !== 1 || parsed.workspaceKey !== workspaceKey(cwd)) return blankRecord(cwd);
		parsed.threads ??= {};
		return parsed;
	} catch {
		return blankRecord(cwd);
	}
}

export function saveDesktopSession(record: DesktopSessionRecord): void {
	const path = join(getAgentDir(), "desktop-sessions", `${record.workspaceKey}.json`);
	mkdirSync(join(getAgentDir(), "desktop-sessions"), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
	renameSync(tmp, path);
}

/** Serialize mutations for one workspace so two commands cannot start two sessions. */
export function updateDesktopSession<T>(cwd: string, fn: (record: DesktopSessionRecord) => T | Promise<T>): Promise<T> {
	const key = workspaceKey(cwd);
	const previous = chains.get(key) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(async () => {
		const record = loadDesktopSession(cwd);
		const result = await fn(record);
		saveDesktopSession(record);
		return result;
	});
	chains.set(key, run);
	return run;
}

export function threadBinding(record: DesktopSessionRecord, threadId: string): DesktopThreadBinding {
	const existing = record.threads[threadId];
	if (existing) {
		existing.elements ??= {};
		return existing;
	}
	const created = blankThread();
	record.threads[threadId] = created;
	return created;
}

export function indexElements(elements: CompactElement[]): Record<string, DesktopElementRecord> {
	const indexed: Record<string, DesktopElementRecord> = {};
	for (const element of elements) {
		indexed[element.ref_id] = {
			name: element.name,
			role: element.role,
			web: element.role ? /webarea|axwebarea|^web$|^html$/i.test(element.role) : false,
		};
	}
	return indexed;
}

/** Names for refs this machine has indexed, across workspace files. Used at classify time. */
export function lookupRefNames(refs: readonly string[]): string[] {
	if (refs.length === 0) return [];
	const dir = join(getAgentDir(), "desktop-sessions");
	const names: string[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const wanted = new Set(refs);
	for (const file of files) {
		try {
			const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as DesktopSessionRecord;
			for (const thread of Object.values(record.threads ?? {})) {
				for (const ref of wanted) {
					const name = thread.elements?.[ref]?.name;
					if (name) names.push(name);
				}
			}
		} catch {
			// Ignore a corrupt session file. The command will snapshot again.
		}
	}
	return names;
}

export function resetDesktopSessionsForTests(): void {
	chains.clear();
}
