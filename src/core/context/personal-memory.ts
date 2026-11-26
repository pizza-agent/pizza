/**
 * Local, user-owned personal memory for long-running agents.
 *
 * This is deliberately small and inspectable:
 * - explicit writes only (`remember`) — never silent learning
 * - scoped to session / project / global
 * - every item keeps its source event id
 * - export and delete are first-class
 * - local JSON under the agent dir, mode 0600
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.js";

export type MemoryKind = "constraint" | "preference" | "decision" | "fact";
export type MemoryScope = "session" | "project" | "global";

export interface PersonalMemoryItem {
	id: string;
	kind: MemoryKind;
	text: string;
	scope: MemoryScope;
	/** Event that produced this memory; kept for provenance/audit. */
	sourceEventId?: string;
	/** Scope keys; absent for global. */
	sessionId?: string;
	workspaceId?: string;
	confidence: number;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	/** Only explicit user actions create records. */
	createdBy: "user_explicit";
}

export interface MemoryListQuery {
	sessionId?: string;
	workspaceId?: string;
	now?: number;
	/** Include expired items (export/maintenance only). */
	includeExpired?: boolean;
}

export interface RememberInput {
	kind?: MemoryKind;
	text: string;
	scope?: MemoryScope;
	sourceEventId?: string;
	sessionId?: string;
	workspaceId?: string;
	confidence?: number;
	expiresAt?: number;
}

interface MemoryFile {
	version: 1;
	items: PersonalMemoryItem[];
}

/** Scope visibility is shared by list/export/forget so they cannot diverge. */
export function isMemoryVisible(item: PersonalMemoryItem, query: MemoryListQuery = {}): boolean {
	const now = query.now ?? Date.now();
	if (!query.includeExpired && item.expiresAt !== undefined && item.expiresAt <= now) return false;
	if (item.scope === "global") return true;
	if (item.scope === "project") return Boolean(query.workspaceId) && item.workspaceId === query.workspaceId;
	return Boolean(query.sessionId) && item.sessionId === query.sessionId;
}

const MAX_TEXT = 4000;
const KINDS: MemoryKind[] = ["constraint", "preference", "decision", "fact"];
const SCOPES: MemoryScope[] = ["session", "project", "global"];

function memoryFile(dir?: string): string {
	return join(dir ?? join(getAgentDir(), "context-memory"), "memories.json");
}

function validate(input: RememberInput): void {
	if (!input.text.trim()) throw new Error("Memory text must not be empty.");
	if (input.text.length > MAX_TEXT) throw new Error(`Memory text is too long (max ${MAX_TEXT} chars).`);
	if (input.kind && !KINDS.includes(input.kind)) throw new Error(`Unknown memory kind: ${input.kind}`);
	if (input.scope && !SCOPES.includes(input.scope)) throw new Error(`Unknown memory scope: ${input.scope}`);
	if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
		throw new Error("Memory confidence must be between 0 and 1.");
	}
}

export class PersonalMemoryStore {
	constructor(private readonly dir?: string) {}

	private get path(): string {
		return memoryFile(this.dir);
	}

	private async read(): Promise<MemoryFile> {
		try {
			const raw = await readFile(this.path, "utf8");
			const parsed = JSON.parse(raw) as MemoryFile;
			if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("unsupported memory file");
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
			throw error;
		}
	}

	private async write(file: MemoryFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		await chmod(tmp, 0o600).catch(() => {});
		await rename(tmp, this.path);
		await chmod(this.path, 0o600).catch(() => {});
	}

	async list(query: MemoryListQuery = {}): Promise<PersonalMemoryItem[]> {
		const file = await this.read();
		return file.items
			.filter((item) => isMemoryVisible(item, query))
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	async remember(input: RememberInput): Promise<PersonalMemoryItem> {
		validate(input);
		const scope = input.scope ?? "project";
		if (scope === "session" && !input.sessionId) throw new Error("Session-scoped memory requires a session id.");
		if (scope === "project" && !input.workspaceId) throw new Error("Project-scoped memory requires a workspace id.");
		const now = Date.now();
		const file = await this.read();
		const text = input.text.trim();
		const duplicate = file.items.find(
			(item) =>
				item.text === text &&
				item.scope === scope &&
				item.sourceEventId === input.sourceEventId &&
				item.workspaceId === (scope === "project" ? input.workspaceId : undefined) &&
				item.sessionId === (scope === "session" ? input.sessionId : undefined),
		);
		if (duplicate) return duplicate;
		const item: PersonalMemoryItem = {
			id: `mem_${randomUUID()}`,
			kind: input.kind ?? "constraint",
			text,
			scope,
			...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
			...(scope === "session" ? { sessionId: input.sessionId } : {}),
			...(scope === "project" ? { workspaceId: input.workspaceId } : {}),
			confidence: input.confidence ?? 1,
			createdAt: now,
			updatedAt: now,
			...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
			createdBy: "user_explicit",
		};
		file.items.push(item);
		await this.write(file);
		return item;
	}

	async forget(id: string, query: MemoryListQuery = {}): Promise<boolean> {
		const file = await this.read();
		const target = file.items.find((item) => item.id === id);
		if (!target || !isMemoryVisible(target, query)) return false;
		await this.write({ ...file, items: file.items.filter((item) => item.id !== id) });
		return true;
	}

	/** Scope-filtered export. Callers must pass their session/workspace keys. */
	async export(query: MemoryListQuery = {}): Promise<PersonalMemoryItem[]> {
		return this.list(query);
	}
}

export function isExpired(item: PersonalMemoryItem, now = Date.now()): boolean {
	return item.expiresAt !== undefined && item.expiresAt <= now;
}
