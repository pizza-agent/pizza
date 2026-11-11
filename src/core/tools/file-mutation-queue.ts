import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
	let parent = resolve(filePath);
	const missing: string[] = [];
	let symlinkHops = 0;
	for (;;) {
		try {
			return join(realpathSync.native(parent), ...missing);
		} catch {
			// A dangling symlink can still be a valid write target: writing
			// through it creates its destination, rather than replacing the link.
			try {
				const target = readlinkSync(parent);
				if (++symlinkHops > 40) return resolve(filePath);
				parent = resolve(dirname(parent), target);
				continue;
			} catch { /* Not a symlink; find the nearest existing parent. */ }
			const next = dirname(parent);
			if (next === parent) return resolve(filePath);
			missing.unshift(basename(parent));
			parent = next;
		}
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
