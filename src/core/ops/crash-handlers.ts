/**
 * Process-level crash handlers for long-running Pizza daemons.
 *
 * Why this exists: `pizza --mode gateway` and `pizza --mode rpc` are daemons.
 * The gateway in particular hosts a pool of agent subprocesses on behalf of
 * other workspaces. Node terminates the process on an unhandled promise
 * rejection (default since v15) and on an uncaught exception, so a single stray
 * rejection anywhere — a socket write to a client that vanished, a background
 * refresh — would take down the daemon *and* every agent it was managing, with
 * no diagnostic left behind.
 *
 * Policy:
 *
 *  - `unhandledRejection` — log and keep running. An orphaned promise says
 *    nothing about the health of the rest of the process, and for a daemon
 *    staying up is far more valuable than failing fast.
 *  - `uncaughtException` — log, then shut down. After an uncaught throw the
 *    process state is undefined, so we follow Node's guidance and exit rather
 *    than soldier on; the optional `onFatal` hook gets a brief window to
 *    release the socket and stop child agents first.
 *
 * All diagnostics go to **stderr**: stdout is a protocol channel in rpc mode
 * (JSONL) and must never carry log noise.
 */

/** Options for {@link installCrashHandlers}. */
export interface CrashHandlerOptions {
	/** Label used in log output, e.g. "gateway" or "rpc". */
	label: string;
	/**
	 * Best-effort cleanup before exiting on a fatal error. Given a short grace
	 * period, after which the process exits regardless.
	 */
	onFatal?: () => void | Promise<void>;
	/** Exit code for a fatal error. Default: 1. */
	fatalExitCode?: number;
	/** Max time granted to `onFatal` before forcing exit. Default: 2000ms. */
	fatalTimeoutMs?: number;
}

/** Write a line to stderr, swallowing EPIPE and any secondary failure. */
function logStderr(line: string): void {
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// stderr can be a closed pipe (EPIPE) — never let logging itself throw,
		// or we would recurse straight back into the handler we are inside of.
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		return error.stack ?? `${error.name}: ${error.message}`;
	}
	// Non-Error throws (strings, objects) still deserve something readable.
	try {
		return `Non-error thrown: ${JSON.stringify(error)}`;
	} catch {
		return `Non-error thrown: ${String(error)}`;
	}
}

/**
 * Install `unhandledRejection` / `uncaughtException` handlers.
 *
 * Idempotent per process: calling it twice does not double-register. Returns a
 * disposer that removes the handlers again (useful in tests).
 */
export function installCrashHandlers(options: CrashHandlerOptions): () => void {
	const { label, onFatal, fatalExitCode = 1, fatalTimeoutMs = 2000 } = options;

	const onUnhandledRejection = (reason: unknown): void => {
		logStderr(`[${label}] Unhandled promise rejection (continuing): ${describe(reason)}`);
	};

	let fatalInProgress = false;
	const onUncaughtException = (error: unknown): void => {
		// A throw from inside onFatal must not restart this sequence.
		if (fatalInProgress) {
			logStderr(`[${label}] Fatal error during shutdown: ${describe(error)}`);
			process.exit(fatalExitCode);
		}
		fatalInProgress = true;
		logStderr(`[${label}] Uncaught exception — shutting down: ${describe(error)}`);

		if (!onFatal) {
			process.exit(fatalExitCode);
		}

		// Give cleanup a bounded window, then exit no matter what.
		const forceExit = setTimeout(() => process.exit(fatalExitCode), fatalTimeoutMs);
		// Do not hold the event loop open on account of the timer itself.
		forceExit.unref?.();

		void (async () => {
			try {
				await onFatal();
			} catch (cleanupError) {
				logStderr(`[${label}] Cleanup failed: ${describe(cleanupError)}`);
			} finally {
				clearTimeout(forceExit);
				process.exit(fatalExitCode);
			}
		})();
	};

	process.on("unhandledRejection", onUnhandledRejection);
	process.on("uncaughtException", onUncaughtException);

	return () => {
		process.off("unhandledRejection", onUnhandledRejection);
		process.off("uncaughtException", onUncaughtException);
	};
}