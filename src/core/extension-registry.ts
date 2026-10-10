/**
 * Extension registry — the single source of truth for which Pizza plugins
 * (extensions) are installed and enabled, persisted as JSON at
 * `~/.pizza/agent/extensions.json`.
 *
 * Covers both built-in extensions (source "builtin") and installed plugin
 * packages (npm/git/local sources; later also marketplace installs). State is
 * recorded when Pizza installs / uninstalls / toggles a plugin, so nothing
 * has to probe the filesystem or run external commands to answer "is it
 * installed?" — every plugin is managed the same way.
 *
 * Several agent processes (one per workspace) share the file: every mutation
 * is a locked read-modify-write with an atomic rename, and reads always go
 * to disk (the file is tiny) so no process serves a stale view.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

/** Source tag for extensions that ship with Pizza. */
export const BUILTIN_EXTENSION_SOURCE = "builtin";

export const EXTENSION_REGISTRY_VERSION = 1;

/** Per-resource include/exclude patterns for a plugin package (same format as settings `packages` objects). */
export interface ExtensionResourceFilter {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface ExtensionRecord extends ExtensionResourceFilter {
	/** "builtin" for extensions shipped with Pizza; otherwise the package source (npm:..., git:..., or a path). */
	source: string;
	/** Disabled plugins stay installed but are not loaded. */
	enabled: boolean;
	/**
	 * Whether the plugin is installed. Absent only for records carried over
	 * from before the registry existed — resolved once, then recorded.
	 */
	installed?: boolean;
	version?: string;
	/** Where the plugin's files live (packages only). */
	installedPath?: string;
	/** ISO timestamp of the last install through Pizza. */
	installedAt?: string;
}

interface RegistryFile {
	version: number;
	extensions: Record<string, ExtensionRecord>;
}

export interface ExtensionRegistryStorage {
	/** Current file contents, or undefined when the registry has never been written. */
	read(): string | undefined;
	/** Read-modify-write under an exclusive lock. `fn` returns the new contents, or undefined to leave it untouched. */
	update(fn: (current: string | undefined) => string | undefined): void;
}

function lockSyncWithRetry(path: string): () => void {
	const maxAttempts = 50;
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false, stale: 10_000 });
		} catch (error) {
			const code = (error as { code?: unknown } | null)?.code;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			const start = Date.now();
			while (Date.now() - start < 20) {
				// Sleep synchronously: callers are sync, and contention is brief.
			}
		}
	}
}

export class FileExtensionRegistryStorage implements ExtensionRegistryStorage {
	constructor(readonly path: string) {}

	read(): string | undefined {
		try {
			return readFileSync(this.path, "utf-8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return undefined;
			throw error;
		}
	}

	update(fn: (current: string | undefined) => string | undefined): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const release = lockSyncWithRetry(this.path);
		try {
			const next = fn(existsSync(this.path) ? readFileSync(this.path, "utf-8") : undefined);
			if (next === undefined) return;
			// Write-then-rename so readers in other processes never see a half-written file.
			const tmp = `${this.path}.${process.pid}.tmp`;
			writeFileSync(tmp, next, "utf-8");
			renameSync(tmp, this.path);
		} finally {
			release();
		}
	}
}

export class InMemoryExtensionRegistryStorage implements ExtensionRegistryStorage {
	private content: string | undefined;

	read(): string | undefined {
		return this.content;
	}

	update(fn: (current: string | undefined) => string | undefined): void {
		const next = fn(this.content);
		if (next !== undefined) this.content = next;
	}
}

function parse(content: string | undefined): RegistryFile {
	if (!content) return { version: EXTENSION_REGISTRY_VERSION, extensions: {} };
	const parsed = JSON.parse(content) as Partial<RegistryFile>;
	return {
		version: parsed.version ?? EXTENSION_REGISTRY_VERSION,
		extensions: parsed.extensions && typeof parsed.extensions === "object" ? parsed.extensions : {},
	};
}

function serialize(file: RegistryFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

export class ExtensionRegistry {
	constructor(private readonly storage: ExtensionRegistryStorage) {}

	static file(path: string): ExtensionRegistry {
		return new ExtensionRegistry(new FileExtensionRegistryStorage(path));
	}

	static inMemory(): ExtensionRegistry {
		return new ExtensionRegistry(new InMemoryExtensionRegistryStorage());
	}

	/**
	 * All records keyed by id (built-in id, or the package source), in insertion
	 * order — which is also the load order for packages. A corrupt file reads as
	 * empty; mutations refuse to overwrite it (see {@link mutate}).
	 */
	list(): Record<string, ExtensionRecord> {
		try {
			return parse(this.storage.read()).extensions;
		} catch {
			return {};
		}
	}

	get(id: string): ExtensionRecord | undefined {
		return this.list()[id];
	}

	/** Records whose source is not "builtin" (installed plugin packages), in load order. */
	listPackages(): Array<[id: string, record: ExtensionRecord]> {
		return Object.entries(this.list()).filter(([, record]) => record.source !== BUILTIN_EXTENSION_SOURCE);
	}

	/** Shallow-merge `patch` into the record for `id`, creating it from `defaults` when missing. */
	patch(id: string, patch: Partial<ExtensionRecord>, defaults: ExtensionRecord): ExtensionRecord {
		let result!: ExtensionRecord;
		this.mutate((extensions) => {
			result = dropUndefined({ ...(extensions[id] ?? defaults), ...patch });
			extensions[id] = result;
		});
		return result;
	}

	/** Replace the record for `id` (appended at the end when new). */
	set(id: string, record: ExtensionRecord): void {
		this.mutate((extensions) => {
			extensions[id] = dropUndefined({ ...record });
		});
	}

	/** Delete the record for `id`. Returns false when there was none. */
	remove(id: string): boolean {
		let removed = false;
		this.mutate((extensions) => {
			removed = id in extensions;
			delete extensions[id];
		});
		return removed;
	}

	/**
	 * Run an arbitrary edit of the whole record map under the lock. Insertion
	 * order of the returned map is persisted (it is the package load order).
	 */
	mutate(fn: (extensions: Record<string, ExtensionRecord>) => void | Record<string, ExtensionRecord>): void {
		this.storage.update((current) => {
			// Throws on a corrupt file — never clobber what the user may want to repair.
			const file = parse(current);
			const replaced = fn(file.extensions);
			return serialize({ version: EXTENSION_REGISTRY_VERSION, extensions: replaced ?? file.extensions });
		});
	}
}

const FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

/** Package source as written in settings (`"npm:foo"` or `{ source, extensions?, ... }`). */
export type PackageSourceLike = string | ({ source: string } & ExtensionResourceFilter);

/** A fresh, enabled + installed record for a configured package source. */
export function packageSourceToRecord(pkg: PackageSourceLike): ExtensionRecord {
	if (typeof pkg === "string") return { source: pkg, enabled: true, installed: true };
	const record: ExtensionRecord = { source: pkg.source, enabled: true, installed: true };
	for (const key of FILTER_KEYS) if (pkg[key] !== undefined) record[key] = pkg[key];
	return record;
}

/** The settings-style package source (string, or object form when filters are set) for a record. */
export function recordToPackageSource(record: ExtensionRecord): PackageSourceLike {
	const filters = FILTER_KEYS.filter((key) => record[key] !== undefined);
	if (filters.length === 0) return record.source;
	const pkg: { source: string } & ExtensionResourceFilter = { source: record.source };
	for (const key of filters) pkg[key] = record[key];
	return pkg;
}

/** Replace a record's resource filters with those of `pkg` (dropping filters it no longer has). */
export function withPackageFilters(record: ExtensionRecord, pkg: PackageSourceLike): ExtensionRecord {
	const next: ExtensionRecord = { ...record };
	for (const key of FILTER_KEYS) delete next[key];
	return { ...next, ...packageSourceToRecord(pkg), enabled: record.enabled, installed: record.installed };
}

function dropUndefined(record: ExtensionRecord): ExtensionRecord {
	for (const key of Object.keys(record) as Array<keyof ExtensionRecord>) {
		if (record[key] === undefined) delete record[key];
	}
	return record;
}
