/**
 * Voice message support — configuration, credential resolution, and the
 * shared transcribe pipeline used by adapters that receive audio
 * (Lark voice messages today; Telegram voice notes etc. can reuse this).
 *
 * Config lives in `<agentDir>/settings.json` under `voice`:
 *
 *   { "voice": {
 *       "provider": "groq" | "openai-compatible" | "cli",
 *       "model": "whisper-large-v3-turbo",     // provider default if unset
 *       "baseUrl": "https://api.groq.com/openai/v1",  // openai-compatible only
 *       "apiKey": "GROQ_API_KEY",              // optional override — env var
 *                                              // NAME, "!command", or literal;
 *                                              // otherwise auth.json[provider] → env
 *       "language": "zh",                      // optional hint
 *       "minDurationMs": 500,                  // skip shorter clips (default 0)
 *       "command": "whisper-cli -m model.bin -f {file} -nt"  // cli provider
 *   } }
 *
 * Secrets never live here in plaintext unless the user insists — `apiKey`
 * goes through the same resolveConfigValue indirection as models.json
 * ("env:NAME" / "!command"), and the default lookup reuses auth.json.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth/auth-storage.js";
import { resolveConfigValue } from "../../src/core/config/resolve-config-value.js";

// ── config ────────────────────────────────────────────────────────────────

export type VoiceProvider = "groq" | "openai-compatible" | "cli";

export interface VoiceSettings {
	provider?: VoiceProvider;
	/** STT model id; defaults per provider (groq → whisper-large-v3-turbo). */
	model?: string;
	/** Transcriptions endpoint base (openai-compatible provider). */
	baseUrl?: string;
	/** Optional key override — "env:NAME", "!command", or literal. Otherwise
	 *  resolved from auth.json[<provider>] then provider env vars. */
	apiKey?: string;
	/** BCP-47 language hint passed to providers that accept one. */
	language?: string;
	/** Voice clips shorter than this are skipped. Default 0. */
	minDurationMs?: number;
	/** cli provider: command template; `{file}` is replaced with the audio path. */
	command?: string;
	/** cli provider: audio format fed to the command. Default "wav" (converted
	 *  with ffmpeg when the input isn't wav already). */
	format?: string;
}

/** Read the `voice` section of `<agentDir>/settings.json`; {} when absent. */
export function loadVoiceSettings(agentDir: string): VoiceSettings {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { voice?: VoiceSettings };
		return parsed.voice ?? {};
	} catch {
		return {};
	}
}

// ── credentials ───────────────────────────────────────────────────────────

/** Env vars checked per provider, in order. */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
	groq: ["GROQ_API_KEY"],
	"openai-compatible": ["OPENAI_API_KEY"],
};

let authStorage: AuthStorage | undefined;

/**
 * Resolve the API key for a voice provider.
 *   1. `voice.apiKey` via resolveConfigValue (env var name / "!cmd" / literal)
 *   2. auth.json[<provider>] (also resolveConfigValue-processed)
 *   3. provider-specific env vars
 */
export async function resolveVoiceApiKey(settings: VoiceSettings, agentDir: string): Promise<string | undefined> {
	if (settings.apiKey) {
		const resolved = resolveConfigValue(settings.apiKey);
		if (resolved) return resolved;
	}
	const provider = settings.provider ?? "groq";
	authStorage ??= AuthStorage.create(join(agentDir, "auth.json"));
	const stored = await authStorage.getApiKey(provider, { includeFallback: false });
	if (stored) return stored;
	for (const envName of PROVIDER_ENV_KEYS[provider] ?? []) {
		const value = process.env[envName];
		if (value) return value;
	}
	return undefined;
}

// ── transcription ─────────────────────────────────────────────────────────

export interface TranscribeInput {
	/** Encoded audio bytes (e.g. opus from Lark). */
	audio: Buffer;
	/** File extension without dot, for upload filename / cli input ("opus"). */
	format: string;
	/** Clip duration in ms, when the platform reports it. */
	durationMs?: number;
}

export interface TranscribeResult {
	text: string;
	provider: string;
}

export interface Transcriber {
	transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODELS: Record<VoiceProvider, string> = {
	groq: "whisper-large-v3-turbo",
	"openai-compatible": "whisper-1",
	cli: "",
};

/** POST {baseUrl}/audio/transcriptions — the OpenAI-compatible STT shape
 *  shared by OpenAI, Groq, DeepInfra, etc. */
function makeApiTranscriber(
	provider: "groq" | "openai-compatible",
	baseUrl: string,
	apiKey: string,
	settings: VoiceSettings,
): Transcriber {
	return {
		async transcribe(input) {
			const form = new FormData();
			form.append("file", new Blob([input.audio]), `voice.${input.format || "opus"}`);
			form.append("model", settings.model ?? DEFAULT_MODELS[provider]);
			if (settings.language) form.append("language", settings.language);
			// Global fetch already honors HTTPS_PROXY via undici's env agent —
			// the supervisor injects the user's proxy into this process.
			const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}` },
				body: form,
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`${provider} transcription failed: HTTP ${res.status} ${body.slice(0, 200)}`);
			}
			const data = (await res.json()) as { text?: string };
			if (!data.text?.trim()) throw new Error(`${provider} returned an empty transcript`);
			return { text: data.text.trim(), provider };
		},
	};
}

/** cli provider — write audio to a temp file, run the command template,
 *  take stdout as the transcript. `{file}` in the command is the audio path. */
function makeCliTranscriber(settings: VoiceSettings): Transcriber {
	return {
		async transcribe(input) {
			const template = settings.command?.trim();
			if (!template) throw new Error('voice.command is required for the "cli" provider');
			const wantFormat = settings.format ?? "wav";
			const tmp = join(tmpdir(), `pizza-voice-${randomBytes(6).toString("hex")}.${wantFormat}`);
			try {
				await writeFile(tmp, await ensureFormat(input.audio, input.format, wantFormat));
				const cmd = template.replaceAll("{file}", tmp);
				const { stdout } = await execShell(cmd, 120_000);
				const text = stdout.trim();
				if (!text) throw new Error("cli transcriber produced no output");
				return { text, provider: "cli" };
			} finally {
				void import("node:fs/promises").then((fs) => fs.unlink(tmp).catch(() => {}));
			}
		},
	};
}

/** Convert audio to `want` format via ffmpeg when needed. */
async function ensureFormat(audio: Buffer, from: string, want: string): Promise<Buffer> {
	if (from === want) return audio;
	const inFile = join(tmpdir(), `pizza-voice-in-${randomBytes(6).toString("hex")}.${from || "opus"}`);
	const outFile = `${inFile}.${want}`;
	try {
		await writeFile(inFile, audio);
		await execShell(`ffmpeg -y -v error -i "${inFile}" -ar 16000 -ac 1 "${outFile}"`, 60_000);
		return Buffer.from(await import("node:fs/promises").then((fs) => fs.readFile(outFile)));
	} finally {
		void import("node:fs/promises").then((fs) => {
			fs.unlink(inFile).catch(() => {});
			fs.unlink(outFile).catch(() => {});
		});
	}
}

function execShell(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("/bin/sh", ["-c", cmd], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`command failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`));
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

// ── the pipeline adapters call ────────────────────────────────────────────

export interface VoicePipeline {
	/** False when `voice.provider` isn't configured — the adapter should skip
	 *  downloading the clip entirely and forward the <audio> tag as today. */
	readonly enabled: boolean;
	/** Transcribe audio bytes; null when the clip was skipped (too short). */
	transcribe(input: TranscribeInput): Promise<TranscribeResult | null>;
}

/**
 * Build the voice pipeline for an adapter. Returns a no-op pipeline when
 * `voice.provider` isn't configured (adapter then falls back to forwarding
 * the raw <audio> tag, preserving today's behavior).
 */
export function createVoicePipeline(agentDir: string): VoicePipeline {
	const settings = loadVoiceSettings(agentDir);
	const provider = settings.provider;
	if (!provider) {
		return { enabled: false, transcribe: async () => null };
	}
	if (provider === "cli") {
		const cli = makeCliTranscriber(settings);
		return {
			enabled: true,
			transcribe: (input) => {
				if (settings.minDurationMs && (input.durationMs ?? Infinity) < settings.minDurationMs) return Promise.resolve(null);
				return cli.transcribe(input);
			},
		};
	}
	if (provider === "groq" || provider === "openai-compatible") {
		let cached: Promise<Transcriber> | undefined;
		const getTranscriber = (): Promise<Transcriber> => {
			cached ??= (async () => {
				const apiKey = await resolveVoiceApiKey(settings, agentDir);
				if (!apiKey) {
					throw new Error(
						`no API key for voice provider "${provider}" — set voice.apiKey, auth.json["${provider}"], or ${(PROVIDER_ENV_KEYS[provider] ?? []).join("/")}`,
					);
				}
				const baseUrl = provider === "groq" ? GROQ_BASE_URL : settings.baseUrl;
				if (!baseUrl) throw new Error(`voice.baseUrl is required for the "openai-compatible" provider`);
				return makeApiTranscriber(provider, baseUrl, apiKey, settings);
			})();
			return cached;
		};
		return {
			enabled: true,
			transcribe: async (input) => {
				if (settings.minDurationMs && (input.durationMs ?? Infinity) < settings.minDurationMs) return null;
				return (await getTranscriber()).transcribe(input);
			},
		};
	}
	return { enabled: false, transcribe: async () => null };
}
