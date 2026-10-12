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
 *       "command": "whisper-cli -m model.bin -f {file} -nt"  // cli provider;
 *                                                  // {file} = audio, {out} = transcript path
 *   } }
 *
 * Secrets never live here in plaintext unless the user insists — `apiKey`
 * goes through the same resolveConfigValue indirection as models.json
 * ("env:NAME" / "!command"), and the default lookup reuses auth.json.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VoiceSettings } from "@tomsun28/pizza-protocol";
import { AuthStorage } from "../../src/core/auth/auth-storage.js";
import { resolveConfigValue } from "../../src/core/config/resolve-config-value.js";

// ── config ────────────────────────────────────────────────────────────────

export type { VoiceSettings };
export type VoiceProvider = NonNullable<VoiceSettings["provider"]>;

/** Read the `voice` section of `<agentDir>/settings.json`; {} when absent. */
export function loadVoiceSettings(agentDir: string): VoiceSettings {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { voice?: VoiceSettings };
		return parsed.voice ?? {};
	} catch (err) {
		console.warn(`[voice] ignoring settings.json — parse failed: ${err instanceof Error ? err.message : String(err)}`);
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

/** cli provider — write audio to a temp file, run the command template.
 *  `{file}` in the command is the audio path; `{out}` is an output path —
 *  when used, the transcript is read from `{out}` (or `{out}.txt` for tools
 *  like whisper that append an extension) instead of stdout. */
function makeCliTranscriber(settings: VoiceSettings): Transcriber {
	return {
		async transcribe(input) {
			const template = settings.command?.trim();
			if (!template) throw new Error('voice.command is required for the "cli" provider');
			const wantFormat = settings.format ?? "wav";
			const id = randomBytes(6).toString("hex");
			const tmp = join(tmpdir(), `pizza-voice-${id}.${wantFormat}`);
			const out = join(tmpdir(), `pizza-voice-out-${id}`);
			try {
				await writeFile(tmp, await ensureFormat(input.audio, input.format, wantFormat));
				const cmd = template.replaceAll("{file}", tmp).replaceAll("{out}", out);
				const { stdout } = await execShell(cmd, 120_000);
				let text = stdout.trim();
				if (!text && template.includes("{out}")) {
					// Tools like mlx-whisper write <name>.txt; others write {out}.
					for (const p of [out, `${out}.txt`]) {
						try {
							text = (await readFile(p, "utf8")).trim();
							if (text) break;
						} catch {
							/* keep looking */
						}
					}
				}
				if (!text) throw new Error("cli transcriber produced no output");
				return { text, provider: "cli" };
			} finally {
				void unlink(tmp).catch(() => {});
				void unlink(out).catch(() => {});
				void unlink(`${out}.txt`).catch(() => {});
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
		return Buffer.from(await readFile(outFile));
	} finally {
		void unlink(inFile).catch(() => {});
		void unlink(outFile).catch(() => {});
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

/**
 * Cache an inbound clip under `<agentDir>/voice-cache/` so UIs can offer
 * playback later. Returns the agentDir-relative path for the `file` attr —
 * opaque to the model, resolvable by trusted UI components only.
 */
const CACHE_MAX_FILES = 200;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function cacheClip(agentDir: string, channel: string, key: string, ext: string, audio: Buffer): string {
	const safe = (s: string): string => s.replace(/[^\w.-]/g, "_");
	const rel = join("voice-cache", safe(channel), `${safe(key)}.${ext}`);
	const abs = join(agentDir, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, audio);
	pruneVoiceCache(agentDir);
	return rel;
}

/** Drop clips older than 7 days, then oldest-first beyond 200 files. */
function pruneVoiceCache(agentDir: string): void {
	const root = join(agentDir, "voice-cache");
	try {
		const files: { path: string; mtime: number }[] = [];
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			for (const f of readdirSync(join(root, dir.name))) {
				const p = join(root, dir.name, f);
				try {
					files.push({ path: p, mtime: statSync(p).mtimeMs });
				} catch { /* gone */ }
			}
		}
		const cutoff = Date.now() - CACHE_MAX_AGE_MS;
		const stale = files.filter((f) => f.mtime < cutoff);
		for (const f of stale) unlinkSync(f.path);
		const live = files.filter((f) => f.mtime >= cutoff).sort((a, b) => a.mtime - b.mtime);
		for (const f of live.slice(0, Math.max(0, live.length - CACHE_MAX_FILES))) unlinkSync(f.path);
	} catch { /* best effort */ }
}

// ── outbound TTS ──────────────────────────────────────────────────────────

/** Text inside <speak>…</speak> segments; undefined when none exist. */
export function extractSpeakText(reply: string): string | undefined {
	const parts = [...reply.matchAll(/<speak>([\s\S]*?)<\/speak>/g)].map((m) => m[1].trim()).filter(Boolean);
	return parts.length ? parts.join("\n\n") : undefined;
}

/** Reply with <speak> wrappers removed (inner text kept) — used for the text
 *  copy that accompanies / falls back from a voice reply. */
export function stripSpeakTags(reply: string): string {
	return reply.replace(/<\/?speak>/g, "");
}

export interface Synthesizer {
	speak(text: string): Promise<Buffer>;
}

/** POST {baseUrl}/audio/speech — OpenAI-compatible TTS (OpenAI tts-1, Groq
 *  playai-tts, DeepInfra…). Requests opus so Feishu gets a playable format
 *  without a transcode. */
function makeApiSynthesizer(
	baseUrl: string,
	apiKey: string,
	settings: VoiceSettings,
): Synthesizer {
	return {
		async speak(text) {
			const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: settings.outboundModel ?? "tts-1",
					voice: settings.outboundVoice ?? "alloy",
					input: text,
					response_format: "opus",
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`TTS failed: HTTP ${res.status} ${body.slice(0, 200)}`);
			}
			return Buffer.from(await res.arrayBuffer());
		},
	};
}

/** cli outbound — write the reply text to a temp file, run `sayCommand`,
 *  read `{out}` back as audio bytes. */
function makeCliSynthesizer(settings: VoiceSettings): Synthesizer {
	return {
		async speak(text) {
			const template = settings.sayCommand?.trim();
			if (!template) throw new Error('voice.sayCommand is required for the "cli" outbound provider');
			const id = randomBytes(6).toString("hex");
			const textFile = join(tmpdir(), `pizza-say-${id}.txt`);
			const out = join(tmpdir(), `pizza-say-${id}.${settings.sayFormat ?? "opus"}`);
			try {
				await writeFile(textFile, text);
				const cmd = template.replaceAll("{text}", textFile).replaceAll("{out}", out);
				await execShell(cmd, 120_000);
				return Buffer.from(await readFile(out));
			} finally {
				void unlink(textFile).catch(() => {});
				void unlink(out).catch(() => {});
			}
		},
	};
}

// ── the pipeline adapters call ────────────────────────────────────────────

/**
 * Inbound text for a voice clip. `transcript` set → the agent reads it as the
 * user's words; absent → an <audio> placeholder plus a hint that no
 * transcript exists, so the agent asks the user to type instead of trying to
 * interpret the tag.
 */
export function voicePrompt(opts: { key?: string; durationMs?: number; transcript?: string; file?: string }): string {
	const { key, durationMs, transcript, file } = opts;
	const duration = durationMs ? Math.round(durationMs / 1000) : undefined;
	const attrs = `${key ? ` key="${key}"` : ""}${duration !== undefined ? ` duration="${duration}s"` : ""}${file ? ` file="${file}"` : ""}`;
	// Neutralize markup inside the transcript — STT output is arbitrary text
	// and a stray "</voice>" would corrupt UI segmentation.
	const safe = transcript?.replace(/<\/?(voice|audio|message)[^>]*>/gi, "") ?? "";
	return safe
		? `<voice${attrs}>${safe}</voice>`
		: `<audio${attrs}/>\n[voice message received but not transcribed]`;
}

export interface VoicePipeline {
	/** False when `voice.provider` isn't configured — the adapter should skip
	 *  downloading the clip entirely and forward the <audio> tag as today. */
	readonly enabled: boolean;
	/** Transcribe audio bytes; null when the clip was skipped (too short). */
	transcribe(input: TranscribeInput): Promise<TranscribeResult | null>;
	/** Whether replies should be spoken for this inbound message. */
	shouldSpeak(input: { inboundWasVoice: boolean; replyContainsSpeakTag?: boolean }): boolean;
	/** Whether outbound voice is configured at all (mode != "off"). */
	readonly canSpeak: boolean;
	/** The configured outbound mode, for adapters that surface it to the agent. */
	readonly outboundMode: "off" | "mirror" | "always" | "agent";
	/** Synthesize reply text into audio bytes (opus). */
	speak(text: string): Promise<Buffer>;
}

/**
 * Build the voice pipeline for an adapter. Returns a no-op pipeline when
 * `voice.provider` isn't configured (adapter then falls back to forwarding
 * the raw <audio> tag, preserving today's behavior).
 */
export function createVoicePipeline(agentDir: string): VoicePipeline {
	const settings = loadVoiceSettings(agentDir);
	const provider = settings.provider;
	const mode = settings.outboundMode ?? "off";
	const shouldSpeak: VoicePipeline["shouldSpeak"] = ({ inboundWasVoice, replyContainsSpeakTag }) => {
		if (mode === "always") return true;
		if (mode === "mirror") return inboundWasVoice;
		if (mode === "agent") return replyContainsSpeakTag === true;
		return false;
	};
	const noSpeak: VoicePipeline["speak"] = async () => {
		throw new Error("voice outbound is not configured");
	};
	if (!provider && !settings.outboundProvider) {
		return { enabled: false, transcribe: async () => null, shouldSpeak, canSpeak: false, outboundMode: "off", speak: noSpeak };
	}
	const withinDuration = (input: TranscribeInput): boolean => {
		const d = input.durationMs;
		if (d === undefined) return true;
		if (settings.minDurationMs && d < settings.minDurationMs) return false;
		if (d > (settings.maxDurationMs ?? 300_000)) return false;
		return true;
	};
	const makeInbound = (): Pick<VoicePipeline, "transcribe"> => {
		if (provider === "cli") {
			const cli = makeCliTranscriber(settings);
			return {
				transcribe: (input) => (withinDuration(input) ? cli.transcribe(input) : Promise.resolve(null)),
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
				transcribe: async (input) => {
					if (!withinDuration(input)) return null;
					return (await getTranscriber()).transcribe(input);
				},
			};
		}
		return { transcribe: async () => null };
	};

	const outProvider = settings.outboundProvider ?? "cli";
	let cachedSynthesizer: Promise<Synthesizer> | undefined;
	const getSynthesizer = (): Promise<Synthesizer> => {
		cachedSynthesizer ??= (async () => {
			if (outProvider === "cli") return makeCliSynthesizer(settings);
			const apiKey =
				(settings.outboundApiKey ? resolveConfigValue(settings.outboundApiKey) : undefined) ??
				(await resolveVoiceApiKey(settings, agentDir));
			if (!apiKey) throw new Error(`no API key for outbound voice provider "${outProvider}"`);
			const baseUrl = outProvider === "groq" ? GROQ_BASE_URL : settings.outboundBaseUrl;
			if (!baseUrl) throw new Error(`voice.outboundBaseUrl is required for the "openai-compatible" provider`);
			return makeApiSynthesizer(baseUrl, apiKey, settings);
		})();
		return cachedSynthesizer;
	};
	return {
		enabled: provider !== undefined,
		...makeInbound(),
		shouldSpeak,
		canSpeak: mode !== "off",
		outboundMode: mode,
		speak: async (text) => (await getSynthesizer()).speak(text),
	};
}
