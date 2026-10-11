import { existsSync, statSync } from "fs";

/**
 * Identity of a config file at a point in time.
 *
 * `undefined` means "the file does not exist". A missing file and an existing
 * one are different versions, so creating or deleting a config counts as a
 * change just like editing it does.
 */
export type FileVersion = string | undefined;

/**
 * Snapshot a config file's version.
 *
 * Uses mtime + size rather than content hashing: config reads happen on hot
 * paths (every settings getter), and a stat is orders of magnitude cheaper than
 * reading and hashing the file. Size is included because mtime alone has
 * coarse granularity on some filesystems, so a same-millisecond edit that
 * changes length is still detected.
 */
export function readFileVersion(path: string | undefined): FileVersion {
	if (!path) return undefined;
	try {
		if (!existsSync(path)) return undefined;
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		// Unreadable (permissions, race with a delete) is treated as "missing"
		// rather than throwing: config freshness must never break a read path.
		return undefined;
	}
}

/**
 * Tracks whether config files changed on disk since we last loaded them.
 *
 * Config files are edited out-of-band — by hand, by another running instance,
 * or by a sibling agent — so in-memory state goes stale until restart. Rather
 * than installing fs watchers (background handles, missed events on atomic
 * rename, per-platform quirks), consumers call `hasChanged()` on their read
 * paths and reload lazily. The cost is a stat per read and it can never miss an
 * edit, because the check happens at the moment the value is actually used.
 */
export class ConfigFileVersionTracker {
	private versions = new Map<string, FileVersion>();

	/**
	 * True when `path` differs from the version recorded by the last `record()`.
	 * Untracked paths report changed, so the first call loads.
	 */
	hasChanged(key: string, path: string | undefined): boolean {
		if (!this.versions.has(key)) return true;
		return this.versions.get(key) !== readFileVersion(path);
	}

	/**
	 * Remember the current on-disk version of `path` as "what we have loaded".
	 *
	 * Call this after loading *and* after writing. Recording our own writes is
	 * what keeps a save from looking like an external edit and triggering a
	 * redundant reload on the next read.
	 */
	record(key: string, path: string | undefined): void {
		this.versions.set(key, readFileVersion(path));
	}

	/** Forget a tracked file so the next `hasChanged()` reports changed. */
	invalidate(key: string): void {
		this.versions.delete(key);
	}
}