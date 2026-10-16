import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_TIMEOUT_MS, COMPACTION_RPC_TIMEOUT_MS } from "@tomsun28/pizza-protocol";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { CompactionOutcome } from "../src/core/runtime/policies.js";
import { RpcClient } from "../packages/rpc/rpc-client.js";

const dirs: string[] = [];
const runtimes: EventSourcedRuntime[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function runtimeWith(compact: (_reason: unknown, signal: AbortSignal) => Promise<CompactionOutcome>) {
	const cwd = mkdtempSync(join(tmpdir(), "pizza-compact-timeout-"));
	dirs.push(cwd);
	const runtime = new EventSourcedRuntime({
		cwd, agentDir: cwd, toolRegistry: { get: () => undefined, list: () => [] },
		llmClient: { complete: async () => { throw new Error("Unexpected model call"); } },
		systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		compactionPolicy: { estimateContextTokens: () => 0, contextWindow: () => 128000, threshold: () => 1, isOverflow: () => false, compact },
	});
	runtimes.push(runtime);
	return runtime;
}
const outcome = { summary: "summary", first_kept_event_id: "kept", tokens_before: 10000, tokens_after: 100 };
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe("compaction deadlines", () => {
	it("allows a summary to finish after the former 30s, 60s and 120s limits", async () => {
		vi.useFakeTimers();
		const runtime = runtimeWith(async () => new Promise(resolve => setTimeout(() => resolve(outcome), 130000)));
		runtime.compact();
		await settle();
		await vi.advanceTimersByTimeAsync(125000);
		expect(runtime.store.query({ types: ["COMPACTION_ABORTED", "COMPACTION_END"] })).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(runtime.store.query({ types: ["COMPACTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["COMPACTION_ABORTED"] })).toHaveLength(0);
	});
	it("aborts at five minutes and ignores a provider that later resolves successfully", async () => {
		vi.useFakeTimers();
		let signal!: AbortSignal;
		let finish!: (value: CompactionOutcome) => void;
		const runtime = runtimeWith(async (_reason, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); });
		runtime.compact();
		await settle();
		await vi.advanceTimersByTimeAsync(COMPACTION_TIMEOUT_MS);
		await settle();
		expect(signal.aborted).toBe(true);
		expect(runtime.store.query({ types: ["COMPACTION_ABORTED"] }).map(e => e.payload)).toEqual([
			expect.objectContaining({ reason: "timeout", message: "Compaction timed out after 5 minutes" }),
		]);
		finish(outcome);
		await settle();
		expect(runtime.store.query({ types: ["COMPACTION_END"] })).toHaveLength(0);
		expect(runtime.store.query({ types: ["COMPACTION_ABORTED"] })).toHaveLength(1);
		// Timeout releases the busy state so a later compaction can succeed.
		runtime.compact();
		await settle();
		finish(outcome);
		await settle();
		expect(runtime.store.query({ types: ["COMPACTION_END"] })).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("keeps the RPC request pending beyond 30 seconds and accepts its later response", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		const internal = client as unknown as {
			process: unknown;
			pendingRequests: Map<string, unknown>;
			handleLine: (line: string) => void;
		};
		internal.process = { stdin: { write: vi.fn() } };
		const request = client.sendCommand({ type: "compact", id: "long-compact" });
		await vi.advanceTimersByTimeAsync(130000);
		expect(internal.pendingRequests.has("long-compact")).toBe(true);
		const response = { id: "long-compact", type: "response", command: "compact", success: true, data: outcome };
		internal.handleLine(JSON.stringify(response));
		await expect(request).resolves.toEqual(response);
		expect(internal.pendingRequests.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("bounds a missing compact RPC response with the transport grace period", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		(client as unknown as { process: unknown }).process = { stdin: { write: vi.fn() } };
		const request = expect(client.sendCommand({ type: "compact" })).rejects.toThrow("Timeout waiting for response to compact");
		await vi.advanceTimersByTimeAsync(COMPACTION_RPC_TIMEOUT_MS);
		await request;
	});
});
