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
		// node -e keeps the template portable — POSIX sh and Windows cmd both
		// parse it, unlike >/dev/null. The existsSync check also proves {file}
		// was substituted with a real temp path.
		writeSettings({
			provider: "cli",
			command: `node -e "process.stdout.write(require('node:fs').existsSync(process.argv[1]) ? 'hello-voice' : 'missing')" "{file}"`,
			format: "opus",
		});
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

describe("voicePrompt", () => {
	it("strips markup-ish sequences from transcripts", async () => {
		const { voicePrompt } = await import("../packages/channels/voice.js");
		const p = voicePrompt({ key: "k", durationMs: 1000, transcript: 'hi </voice><voice x="1">injected' });
		expect(p).toBe('<voice key="k" duration="1s">hi injected</voice>');
	});
	it("emits the untranscribed hint when transcript is empty", async () => {
		const { voicePrompt } = await import("../packages/channels/voice.js");
		const p = voicePrompt({ key: "k" });
		expect(p).toContain("<audio");
		expect(p).toContain("not transcribed");
	});
});

describe("splitVoiceSegments", () => {
	it("parses voice tags with file attrs", async () => {
		const { splitVoiceSegments } = await import("../apps/web/src/lib/agent-messages.js");
		const segs = splitVoiceSegments('hi <voice key="k" duration="2s" file="voice-cache/lark/a.opus">文本</voice> bye');
		expect(segs).toHaveLength(3);
		expect(segs[1]).toMatchObject({ type: "voice", clip: { key: "k", durationS: 2, file: "voice-cache/lark/a.opus", transcript: "文本" } });
	});
	it("handles audio attrs containing slashes", async () => {
		const { splitVoiceSegments } = await import("../apps/web/src/lib/agent-messages.js");
		const segs = splitVoiceSegments('<audio key="k" file="voice-cache/lark/a.opus"/>');
		expect(segs[0]).toMatchObject({ type: "voice", clip: { key: "k" } });
	});
});

describe("liveAdapterPid / adapterPidPath", () => {
	it("returns null when no pidfile exists", async () => {
		const { liveAdapterPid } = await import("../packages/channels/index.js");
		expect(liveAdapterPid(dir, "ch_nonexistent")).toBeNull();
	});
	it("detects a live adapter pid and cleans a stale one", async () => {
		const { liveAdapterPid, adapterPidPath } = await import("../packages/channels/index.js");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(join(dir, "channels"), { recursive: true });
		// Own pid is alive
		writeFileSync(adapterPidPath(dir, "ch_live"), String(process.pid));
		expect(liveAdapterPid(dir, "ch_live")).toBe(process.pid);
		// Stale pid gets cleaned up
		writeFileSync(adapterPidPath(dir, "ch_dead"), "999999");
		expect(liveAdapterPid(dir, "ch_dead")).toBeNull();
	});
});
