/**
 * Pizza internal benchmark harness.
 *
 * This measures Pizza's own local machinery — event append/query, context
 * projection, observation masking, summary serialization, and CLI startup.
 * It deliberately makes no model calls and reads no API keys, so the numbers
 * are reproducible on any machine and are not a comparison with other agents.
 *
 * Usage:
 *   npm run build            # required for the cli-startup case
 *   npm run bench
 *   npm run bench -- --case compaction-mask --iterations 5
 *   npm run bench -- --json
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { EventBase } from "../src/core/event-store/types.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";
import { maskToolCallArgumentEvents, maskToolResultEvents } from "../src/core/compaction/tool-result-masking.js";
import { serializeConversation } from "../src/core/compaction/utils.js";
import { estimateStringTokens } from "../src/core/compaction/token-estimation.js";

type MetricValue = number | string;

interface Sample {
	ms: number;
	metrics?: Record<string, MetricValue>;
}

interface BenchCase {
	name: string;
	description: string;
	/** Cases that build large fixtures can opt into fewer runs. */
	iterations?: number;
	run: () => Sample | Promise<Sample>;
}

interface CaseResult {
	name: string;
	description: string;
	iterations: number;
	samples: number[];
	metrics: Record<string, MetricValue>;
	skipped?: string;
}

const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

function ms(value: number): string {
	return `${value.toFixed(2)}ms`;
}

function formatMetric(value: MetricValue): string {
	if (typeof value === "number") {
		return Number.isInteger(value) ? String(value) : value.toFixed(2);
	}
	return value;
}

function seedUserMessages(store: SqliteEventStore, count: number, threadId = "bench-thread"): void {
	for (let i = 0; i < count; i++) {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			thread_id: threadId,
			payload: { content: `benchmark message ${i} ${"context ".repeat(24)}` },
		});
	}
}

function descriptorFor(store: SqliteEventStore): SessionDescriptor {
	return {
		session_id: "bench-session",
		thread_id: "bench-thread",
		workspace_id: store.workspace_id,
		event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
		created_by: "user_explicit",
		created_at: Date.now(),
	};
}

function bigToolEvents(): { events: EventBase[]; beforeSequence: number } {
	const events: EventBase[] = [];
	const resultText = "x".repeat(8_000);
	const fileBody = "y".repeat(40_000);
	for (let i = 0; i < 80; i++) {
		const callId = `call_${i}`;
		events.push({
			sequence: i * 2 + 1,
			event_id: `evt_${i * 2 + 1}`,
			workspace_id: "bench",
			runtime_id: "bench",
			actor_id: "coder_agent",
			timestamp: Date.now(),
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [
					{ type: "tool_call", id: callId, name: "_write", arguments: { path: `src/file_${i}.ts`, content: fileBody } },
				],
				model: { provider: "bench", model_id: "bench" },
				usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
				stop_reason: "stop",
			},
			thread_id: "bench-thread",
			schema_version: 1,
		});
		events.push({
			sequence: i * 2 + 2,
			event_id: `evt_${i * 2 + 2}`,
			workspace_id: "bench",
			runtime_id: "bench",
			actor_id: "runtime",
			timestamp: Date.now(),
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: callId,
				tool_name: "_write",
				result: [{ type: "text", text: resultText }],
				is_error: false,
				duration_ms: 1,
			},
			thread_id: "bench-thread",
			schema_version: 1,
		});
	}
	return { events, beforeSequence: 1_000 };
}

const cases: BenchCase[] = [
	{
		name: "event-store-append",
		description: "Append 10,000 USER_MESSAGE events to an in-memory SQLite store",
		iterations: 5,
		run: () => {
			const store = new SqliteEventStore("bench", ":memory:");
			const count = 10_000;
			const started = performance.now();
			seedUserMessages(store, count);
			const elapsed = performance.now() - started;
			store.close();
			return { ms: elapsed, metrics: { events: count, events_per_sec: Math.round(count / (elapsed / 1_000)) } };
		},
	},
	{
		name: "event-store-query",
		description: "Query 10,000 USER_MESSAGE events back out of the store",
		iterations: 5,
		run: () => {
			const store = new SqliteEventStore("bench", ":memory:");
			const count = 10_000;
			seedUserMessages(store, count);
			const started = performance.now();
			const events = store.query({ types: ["USER_MESSAGE"] });
			const elapsed = performance.now() - started;
			store.close();
			if (events.length !== count) throw new Error(`expected ${count} events, got ${events.length}`);
			return { ms: elapsed, metrics: { events: events.length } };
		},
	},
	{
		name: "context-build",
		description: "Project 5,000 user turns into LLM context",
		iterations: 3,
		run: () => {
			const store = new SqliteEventStore("bench", ":memory:");
			seedUserMessages(store, 5_000);
			const projection = new SessionProjection(store, descriptorFor(store));
			const started = performance.now();
			const context = projection.buildContext();
			const elapsed = performance.now() - started;
			store.close();
			return { ms: elapsed, metrics: { messages: context.messages.length } };
		},
	},
	{
		name: "compaction-mask",
		description: "Mask 80 old tool results and 80 large _write argument payloads",
		iterations: 5,
		run: () => {
			const { events, beforeSequence } = bigToolEvents();
			const input = JSON.stringify(events);
			const started = performance.now();
			const withMaskedResults = maskToolResultEvents(events, beforeSequence);
			const masked = maskToolCallArgumentEvents(withMaskedResults, beforeSequence);
			const elapsed = performance.now() - started;
			const output = JSON.stringify(masked);
			const inputTokens = estimateStringTokens(input);
			const outputTokens = estimateStringTokens(output);
			return {
				ms: elapsed,
				metrics: {
					events: events.length,
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					saved_pct: inputTokens > 0 ? Number((100 * (1 - outputTokens / inputTokens)).toFixed(2)) : 0,
				},
			};
		},
	},
	{
		name: "summary-serialization",
		description: "Serialize an assistant turn with a 2k thinking block and a 40k _write argument",
		iterations: 5,
		run: () => {
			const thinking = "t".repeat(2_000);
			const content = "c".repeat(4_000);
			const fileBody = "x".repeat(40_000);
			const raw = `${thinking}${content}${JSON.stringify({ path: "src/big.ts", content: fileBody })}`;
			const messages = [
				{ role: "user", content: "please write the file" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking },
						{ type: "text", text: content },
						{ type: "toolCall", id: "call_1", name: "_write", arguments: { path: "src/big.ts", content: fileBody } },
					],
				},
			] as Parameters<typeof serializeConversation>[0];
			const started = performance.now();
			const serialized = serializeConversation(messages);
			const elapsed = performance.now() - started;
			const rawTokens = estimateStringTokens(raw);
			const serializedTokens = estimateStringTokens(serialized);
			return {
				ms: elapsed,
				metrics: {
					raw_tokens: rawTokens,
					serialized_tokens: serializedTokens,
					serialized_chars: serialized.length,
					saved_pct: rawTokens > 0 ? Number((100 * (1 - serializedTokens / rawTokens)).toFixed(2)) : 0,
				},
			};
		},
	},
	{
		name: "cli-startup",
		description: "Spawn the built CLI with --version (requires npm run build)",
		iterations: 5,
		run: () => {
			const cli = join(process.cwd(), "dist", "src", "cli.js");
			if (!existsSync(cli)) {
				const metrics: Record<string, MetricValue> = { skipped: "run npm run build first" };
				return { ms: 0, metrics };
			}
			const started = performance.now();
			const result = spawnSync(process.execPath, [cli, "--version"], {
				encoding: "utf8",
				timeout: 15_000,
			});
			const elapsed = performance.now() - started;
			if (result.status !== 0) {
				throw new Error(`cli --version failed (${result.status}): ${result.stderr || result.stdout}`);
			}
			const output = `${result.stdout || ""}\n${result.stderr || ""}`;
			const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][^\s]*)?/)?.[0] ?? output.trim();
			const metrics: Record<string, MetricValue> = { version };
			return { ms: elapsed, metrics };
		},
	},
];

function parseArgs(argv: string[]): {
	json: boolean;
	list: boolean;
	selected: string[];
	iterations?: number;
	warmup: number;
} {
	let json = false;
	let list = false;
	let iterations: number | undefined;
	let warmup = DEFAULT_WARMUP;
	const selected: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--list") list = true;
		else if (arg === "--case") {
			const value = argv[++i];
			if (!value) throw new Error("--case requires a name");
			selected.push(value);
		} else if (arg === "--iterations") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 1) throw new Error("--iterations requires a positive integer");
			iterations = value;
		} else if (arg === "--warmup") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 0) throw new Error("--warmup requires a non-negative integer");
			warmup = value;
		} else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { json, list, selected, iterations, warmup };
}

function printHelp(): void {
	console.log(`Pizza internal benchmark

Usage:
  npm run bench [-- --case <name>] [--iterations N] [--warmup N] [--json] [--list]

Cases:
${cases.map((c) => `  ${c.name.padEnd(24)} ${c.description}`).join("\n")}

Notes:
  - No model calls, API keys, or network access.
  - Run "npm run build" before using the cli-startup case.
  - Results are local timings, not a cross-agent comparison.`);
}

async function runCase(benchCase: BenchCase, iterations: number, warmup: number): Promise<CaseResult> {
	const samples: number[] = [];
	let metrics: Record<string, MetricValue> = {};
	const total = warmup + iterations;
	for (let i = 0; i < total; i++) {
		const sample = await benchCase.run();
		if (sample.metrics?.skipped) {
			return {
				name: benchCase.name,
				description: benchCase.description,
				iterations: 0,
				samples: [],
				metrics: sample.metrics,
				skipped: String(sample.metrics.skipped),
			};
		}
		metrics = sample.metrics ?? {};
		if (i >= warmup) samples.push(sample.ms);
	}
	return {
		name: benchCase.name,
		description: benchCase.description,
		iterations: samples.length,
		samples,
		metrics,
	};
}

function printTable(results: CaseResult[]): void {
	console.log("\nPizza internal benchmark (local machine; no model calls)\n");
	console.log(
		`${"case".padEnd(26)}${"p50".padStart(10)}${"p95".padStart(10)}${"runs".padStart(7)}  metrics`,
	);
	console.log("-".repeat(100));
	for (const result of results) {
		if (result.skipped) {
			console.log(`${result.name.padEnd(26)}${"skipped".padStart(10)}  ${result.skipped}`);
			continue;
		}
		const metricText = Object.entries(result.metrics)
			.map(([key, value]) => `${key}=${formatMetric(value)}`)
			.join("  ");
		console.log(
			`${result.name.padEnd(26)}${ms(median(result.samples)).padStart(10)}${ms(percentile(result.samples, 95)).padStart(10)}${String(result.iterations).padStart(7)}  ${metricText}`,
		);
	}
	console.log("");
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.list) {
		for (const benchCase of cases) console.log(`${benchCase.name}\t${benchCase.description}`);
		return;
	}
	const selected = options.selected.length > 0 ? cases.filter((c) => options.selected.includes(c.name)) : cases;
	const missing = options.selected.filter((name) => !cases.some((c) => c.name === name));
	if (missing.length > 0) {
		throw new Error(`unknown case(s): ${missing.join(", ")}. Use --list to see available cases.`);
	}

	const results: CaseResult[] = [];
	for (const benchCase of selected) {
		const iterations = options.iterations ?? benchCase.iterations ?? DEFAULT_ITERATIONS;
		results.push(await runCase(benchCase, iterations, options.warmup));
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				results.map((result) => ({
					...result,
					p50_ms: result.skipped ? null : Number(median(result.samples).toFixed(2)),
					p95_ms: result.skipped ? null : Number(percentile(result.samples, 95).toFixed(2)),
				})),
				null,
				2,
			),
		);
		return;
	}
	printTable(results);
}

main().catch((error) => {
	console.error(`[bench] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
