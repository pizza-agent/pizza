/** File-backed projections of the main agent's existing identity and memories. */
import { open, readdir, realpath, writeFile, rename, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { MainAgentDocument, MainAgentProfile, MainJournalPage, MainMemorySummary } from "../../../packages/protocol/index.js";
import type { MainAgentRoots } from "../session/session-facade.js";
import { loadPetSave } from "../pet/store.js";
import { SOUL_PLACEHOLDER_MARKER } from "./main-agent.js";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_MEMORIES = 200;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function requireMain(roots?: MainAgentRoots): MainAgentRoots {
	if (!roots) throw new Error("Agent profile is available only in the main agent session");
	return roots;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export async function readMainDocument(roots: MainAgentRoots | undefined, sourceId: string): Promise<MainAgentDocument> {
	const { mainDir, memoryDir } = requireMain(roots);
	if (typeof sourceId !== "string" || sourceId.includes("\\") || sourceId.includes("\0")) throw new Error("Invalid document source");
	const soul = sourceId === "SOUL.md";
	const parts = sourceId.split("/");
	if (!soul && (parts[0] !== "memory" || parts.length < 2 || parts.some((part) => !part || part === "." || part === "..") || !sourceId.endsWith(".md"))) {
		throw new Error("Invalid document source");
	}
	const root = await realpath(soul ? mainDir : memoryDir);
	const path = await realpath(soul ? join(mainDir, "SOUL.md") : resolve(memoryDir, ...parts.slice(1)));
	if (!inside(root, path)) throw new Error("Document is outside the main agent's files");
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error("Document is not a readable Markdown file (limit 512 KiB)");
		// Bounded read even if a file grows after stat().
		const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 512 KiB");
		const content = buffer.subarray(0, bytesRead).toString("utf8");
		return { sourceId, path, content, revision: createHash("sha256").update(content).digest("hex") };
	} finally { await handle.close(); }
}

// Serialize writes to the same canonical file so two UI saves cannot both
// pass the revision check. Files remain the source of truth for external edits.
const writes = new Map<string, Promise<unknown>>();
export async function writeMainDocument(input: MainAgentRoots | undefined, sourceId: string, content: string, expectedRevision: string): Promise<MainAgentDocument> {
	const roots = requireMain(input);
	if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 512 KiB");
	if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("A document revision is required to save changes");
	const initial = await readMainDocument(roots, sourceId);
	const previous = writes.get(initial.path) ?? Promise.resolve();
	const pending = previous.catch(() => {}).then(async () => {
		const current = await readMainDocument(roots, sourceId);
		if (current.path !== initial.path || current.revision !== expectedRevision) throw new Error("DOCUMENT_CONFLICT: This file changed elsewhere. Reload the source before saving again.");
		const temporary = join(dirname(current.path), `.agent-edit-${randomUUID()}.tmp`);
		try {
			const mode = (await stat(current.path)).mode & 0o777;
			await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
			// Recheck external changes and links just before the atomic replacement.
			const latest = await readMainDocument(roots, sourceId);
			if (latest.path !== current.path || latest.revision !== expectedRevision) throw new Error("DOCUMENT_CONFLICT: This file changed elsewhere. Your draft has not been saved.");
			await rename(temporary, current.path);
			return { ...current, content, revision: createHash("sha256").update(content).digest("hex") };
		} finally { await unlink(temporary).catch(() => {}); }
	});
	writes.set(initial.path, pending);
	try { return await pending; }
	finally { if (writes.get(initial.path) === pending) writes.delete(initial.path); }
}

/** Keep source prose, without trying to infer personality or user facts. */
function body(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}
function title(content: string, fallback: string): string {
	return /^#{1,3}\s+(.+)$/m.exec(body(content))?.[1]?.trim() || fallback.replace(/\.md$/, "");
}
function preview(content: string, length = 220, keepLines = false): string {
	return body(content).split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && !/^\s*\(empty\)\s*$/i.test(line) && line.trim() !== "Long-term, stable facts about the user. Update this as you learn more.")
		.join(keepLines ? "\n" : " ").replace(/<!--([\s\S]*?)-->/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "").replace(keepLines ? /[^\S\n]+/g : /\s+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, length);
}

async function optionalDocument(roots: MainAgentRoots, id: string): Promise<MainAgentDocument | null> {
	try { return await readMainDocument(roots, id); } catch (error) { if (missing(error)) return null; throw error; }
}

function validDate(value: string): boolean {
	const date = new Date(`${value}T12:00:00Z`);
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function listMainJournals(input: MainAgentRoots | undefined, before?: string, limit = 20): Promise<MainJournalPage> {
	const roots = requireMain(input);
	if (before !== undefined && (typeof before !== "string" || !validDate(before))) throw new Error("Invalid journal cursor");
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Journal limit must be between 1 and 50");
	let names: string[];
	try {
		const root = await realpath(roots.memoryDir);
		const journal = await realpath(join(root, "journal"));
		if (!inside(root, journal)) throw new Error("Journal is outside memory");
		names = (await readdir(journal)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && validDate(name.slice(0, -3)) && (!before || name.slice(0, -3) < before)).sort().reverse();
	} catch (error) { if (missing(error)) return { entries: [] }; throw error; }
	const selected = names.slice(0, limit);
	const entries = await Promise.all(selected.map(async (name) => {
		const document = await readMainDocument(roots, `memory/journal/${name}`);
		return { sourceId: document.sourceId, date: name.slice(0, -3), title: title(document.content, name), preview: preview(document.content) };
	}));
	return { entries, ...(names.length > limit ? { nextBefore: selected.at(-1)!.slice(0, -3) } : {}) };
}

export async function loadMainProfile(input?: MainAgentRoots): Promise<MainAgentProfile> {
	const roots = requireMain(input);
	const [soul, index, user, journal] = await Promise.all([
		optionalDocument(roots, "SOUL.md"), optionalDocument(roots, "memory/_index.md"),
		optionalDocument(roots, "memory/user-profile.md"), listMainJournals(roots),
	]);
	let files: string[];
	try { files = (await readdir(roots.memoryDir, { withFileTypes: true })).filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md") && entry.name !== "_index.md").map((entry) => entry.name); }
	catch (error) { if (!missing(error)) throw error; files = []; }
	const indexed = new Map<string, string>();
	for (const line of (index?.content ?? "").split(/\r?\n/)) {
		const match = /^\s*[-*]\s+(?:\[[^\]]+\]\(([^/\\]+\.md)\)|`?([^/\\\s`]+\.md)`?)(?:\s*[—–:-]\s*|\s+)?(.*)$/.exec(line);
		if (match) indexed.set(match[1] || match[2], match[3].trim());
	}
	const all = [...new Set([...files.sort(), ...indexed.keys()])].filter((file) => file !== "_index.md");
	const memories: MainMemorySummary[] = await Promise.all(all.slice(0, MAX_MEMORIES).map(async (file) => {
		const sourceId = `memory/${file}`;
		const summary = indexed.get(file) ?? "";
		if (!files.includes(file)) return { sourceId, title: file.replace(/\.md$/, ""), summary, status: "stale" as const };
		try {
			const doc = await readMainDocument(roots, sourceId);
			return { sourceId, title: title(doc.content, file), summary: summary || preview(doc.content, 140), status: indexed.has(file) ? "indexed" as const : "unindexed" as const };
		} catch {
			return { sourceId, title: file.replace(/\.md$/, ""), summary, status: "unavailable" as const };
		}
	}));
	const initialized = Boolean(soul?.content.trim()) && !soul!.content.includes(SOUL_PLACEHOLDER_MARKER);
	// Only an explicitly labelled name is a name; a heading such as Identity isn't.
	const name = initialized ? /^(?:[-*]\s*)?(?:\*\*)?(?:Name|名字|姓名|名称)(?:\*\*)?\s*[:：]\s*(.+)$/im.exec(body(soul!.content))?.[1]?.replace(/\*\*/g, "").trim().slice(0, 60) : undefined;
	const pet = loadPetSave();
	return {
		soul: { initialized, name, summary: initialized ? preview(soul!.content.replace(/^(?:[-*]\s*)?(?:\*\*)?(?:Name|名字|姓名|名称)(?:\*\*)?\s*[:：].+$/gim, ""), 220, true) : "", sourceId: "SOUL.md" },
		userProfile: user ? { sourceId: user.sourceId, summary: preview(user.content, 220, true) } : null,
		pet: pet ? { name: pet.name, speciesId: pet.speciesId } : null,
		memories, memoriesTruncated: all.length > MAX_MEMORIES, journal,
	};
}
