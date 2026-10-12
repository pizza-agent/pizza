/**
 * Voice pipeline tests — settings loading, api-key resolution order,
 * minDurationMs gating, and the cli transcriber (echo-based, offline-safe).
 * The groq/openai-compatible path is covered by the same code minus the
 * fetch; it stays untested here rather than mocking global fetch.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoicePipeline, loadVoiceSettings, resolveVoiceApiKey } from "../packages/channels/voice.js";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pizza-voice-test-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeSettings(voice: unknown): void {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ voice }));
}

describe("loadVoiceSettings", () => {
	it("returns {} when settings.json is absent", () => {
		rmSync(join(dir, "settings.json"), { force: true });
		expect(loadVoiceSettings(dir)).toEqual({});
	});

	it("reads the voice section", () => {
		writeSettings({ provider: "groq", language: "zh" });
		expect(loadVoiceSettings(dir)).toEqual({ provider: "groq", language: "zh" });
	});
});

describe("createVoicePipeline", () => {
	it("is a no-op without a configured provider", async () => {
		writeSettings({});
		const p = createVoicePipeline(dir);
		expect(await p.transcribe({ audio: Buffer.from("x"), format: "opus" })).toBeNull();
	});

	it("skips clips below minDurationMs", async () => {
		writeSettings({ provider: "cli", command: "cat {file}", minDurationMs: 10_000 });
		const p = createVoicePipeline(dir);
		expect(await p.transcribe({ audio: Buffer.from("x"), format: "opus", durationMs: 500 })).toBeNull();
	});

	it("cli provider runs the command template and returns stdout", async () => {
		writeSettings({ provider: "cli", command: "echo transcribed {file} >/dev/null && echo hello-voice", format: "opus" });
		const p = createVoicePipeline(dir);
		const r = await p.transcribe({ audio: Buffer.from("x"), format: "opus" });
		expect(r?.text).toBe("hello-voice");
		expect(r?.provider).toBe("cli");
	});

	it("cli provider surfaces command failures", async () => {
		writeSettings({ provider: "cli", command: "exit 3" });
		const p = createVoicePipeline(dir);
		await expect(p.transcribe({ audio: Buffer.from("x"), format: "opus" })).rejects.toThrow(/command failed/);
	});
});

describe("resolveVoiceApiKey", () => {
	it("resolves an env var name in voice.apiKey", async () => {
		process.env.PIZZA_TEST_VOICE_KEY = "sk-test-123";
		writeSettings({ provider: "groq", apiKey: "PIZZA_TEST_VOICE_KEY" });
		expect(await resolveVoiceApiKey(loadVoiceSettings(dir), dir)).toBe("sk-test-123");
		delete process.env.PIZZA_TEST_VOICE_KEY;
	});

	it("falls back to provider env vars", async () => {
		process.env.GROQ_API_KEY = "gsk-env";
		writeSettings({ provider: "groq" });
		expect(await resolveVoiceApiKey(loadVoiceSettings(dir), dir)).toBe("gsk-env");
		delete process.env.GROQ_API_KEY;
	});
});
