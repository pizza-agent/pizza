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

	it("does not retry 4xx protocol failures even when a UUID contains 5xx digits", () => {
		const p = new DefaultRetryPolicy();
		const message =
			`400: {"message":"Messages with role 'tool' must be a response to a preceding message with 'tool_calls' (request_id: d764c6f8-34b1-4ecb-8016-3189540ce453)","type":"invalid_request_error"}`;
		expect(p.isRetryable({ message })).toBe(false);
		expect(p.isRetryable({ message: "bad request" })).toBe(false);
		expect(p.isRetryable({ message: "whatever", statusCode: 404 })).toBe(false);
	});
});
