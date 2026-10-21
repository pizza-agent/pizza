import { COMPACTION_TIMEOUT_MS } from "../../../packages/protocol/index.js";
import type { CompactionOutcome, CompactionPolicy } from "./policies.js";

/** Both idle and in-turn compaction must cancel before reporting a timeout. */
export async function compactWithDeadline(
	policy: CompactionPolicy,
	reason: Parameters<CompactionPolicy["compact"]>[0],
	controller: AbortController,
): Promise<CompactionOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error("Compaction timed out after 5 minutes");
				error.name = "TimeoutError";
				reject(error);
				controller.abort(error);
			}, COMPACTION_TIMEOUT_MS);
		});
		const result = await Promise.race([policy.compact(reason, controller.signal), deadline]);
		// A provider can ignore cancellation and still resolve. Do not commit its result.
		controller.signal.throwIfAborted();
		return result;
	} finally {
		clearTimeout(timer);
	}
}
