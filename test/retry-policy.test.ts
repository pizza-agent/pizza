/** DefaultRetryPolicy classification — transport-level Bun/undici fetch
 *  failures must be retryable or a flaky proxy kills turns outright. */

import { describe, it, expect } from "vitest";
import { DefaultRetryPolicy } from "../src/core/runtime/policies.js";

describe("DefaultRetryPolicy.isRetryable", () => {
	it("retries Bun's socket-closed fetch error", () => {
		const p = new DefaultRetryPolicy();
		expect(
			p.isRetryable({
				message: "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			}),
		).toBe(true);
	});

	it("retries common transient transport failures", () => {
		const p = new DefaultRetryPolicy();
		for (const message of ["socket hang up", "fetch failed", "connection refused", "terminated", "timed out"]) {
			expect(p.isRetryable({ message }), message).toBe(true);
		}
		expect(p.isRetryable({ message: "rate limited", statusCode: 429 })).toBe(true);
		expect(p.isRetryable({ statusCode: 503 } as { message: string; statusCode: number })).toBe(true);
	});

	it("does not retry non-transient errors", () => {
		const p = new DefaultRetryPolicy();
		expect(p.isRetryable({ message: "invalid api key" })).toBe(false);
		expect(p.isRetryable({ message: "model not found" })).toBe(false);
	});
});
