/**
 * Lark / Feishu channel adapter — receives messages over the SDK's WebSocket
 * long connection (no public webhook endpoint needed — stays local-first),
 * hands them to the workspace agent with Lark provenance, and posts the
 * agent's reply back into the same chat.
 *
 * Config: `appId` / `appSecret` from the developer console. LARK_DOMAIN=lark
 * selects the intl tenant (default: feishu). Group chats require an @mention
 * unless PIZZA_ANSWER_ALL=1; DMs always answer.
 *
 * The Feishu chat id becomes the provenance id: <message from="lark:oc_xxx">.
 *
 * Setup in the Feishu developer console: enable the bot capability, subscribe
 * to the `im.message.receive_v1` event with "long connection" as the delivery
 * mode, and grant the `im:message` / `im:message:send_as_bot` scopes. Add
 * `im:resource` too — voice-message transcription downloads the clip.
 */

import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { Readable } from "node:stream";
import { ANSWER_ALL, errorMessage, failureReply, provenance } from "./runtime.js";
import type { ChannelAdapter } from "./types.js";
import { cacheClipForPlayback, createVoicePipeline, extractSpeakText, stripSpeakTags, voicePrompt } from "./voice.js";

/**
 * Threaded replies stay readable in group chats, but in p2p DMs the Feishu
 * client collapses `replyTo` posts into a sub-thread with no normal
 * notification — users see the bot "not replying". DMs get top-level sends.
 */
function sendOpts(msg: NormalizedMessage): { replyTo?: string } {
	return msg.chatType === "group" ? { replyTo: msg.messageId } : {};
}

export default {
	validate(input) {
		if (!input.appId?.trim()) return "App ID is required";
		if (!input.appSecret?.trim()) return "App Secret is required";
		return null;
	},

	async probe(config, fetch) {
		const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json()) as { code?: number; msg?: string };
		return body.code === 0
			? { ok: true, message: "App credentials are valid" }
			: { ok: false, message: `Feishu rejected the credentials: ${body.msg ?? `code ${body.code}`}` };
	},

	async start(config, runtime) {
		const { Domain, createLarkChannel } = await import("@larksuiteoapi/node-sdk");

		/** Download a message attachment — im.v1.messageResource.get, not
		 *  `downloadResource` (that one calls im/v1/file.get, which only serves
		 *  files the bot itself uploaded → 400 on user voice messages). */
		const downloadMessageResource = async (messageId: string, fileKey: string): Promise<Buffer> => {
			// Retry once — the resource stream occasionally resets mid-download
			// ("socket connection was closed unexpectedly"), and losing a voice
			// message over a transient hiccup is worse than a second fetch.
			let lastErr: unknown;
			// The resource endpoint's socket gets reset fairly often (observed
			// repeatedly on flaky networks) — 3 attempts with linear backoff.
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const res = await lark.rawClient.im.v1.messageResource.get({
						path: { message_id: messageId, file_key: fileKey },
						params: { type: "file" },
					});
					const stream = res.getReadableStream() as Readable;
					const chunks: Buffer[] = [];
					for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
					return Buffer.concat(chunks);
				} catch (err) {
					lastErr = err;
					console.warn(`[lark] resource download attempt ${attempt + 1}/3 failed: ${errorMessage(err)}`);
					if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
				}
			}
			throw lastErr;
		};
		const lark = createLarkChannel({
			appId: config.appId!,
			appSecret: config.appSecret!,
			domain: process.env.LARK_DOMAIN === "lark" ? Domain.Lark : Domain.Feishu,
			transport: "websocket",
			policy: { requireMention: !ANSWER_ALL, dmMode: "open" },
		});

		// Voice pipeline — no-op unless settings.json has a `voice` section.
		const voice = createVoicePipeline(runtime.dir);

		lark.on("message", async (msg: NormalizedMessage) => {
			const chatId = msg.chatId;
			let text = msg.content.trim();

			// Voice message: download the clip and transcribe it when a voice
			// provider is configured; otherwise forward the <audio> tag as-is.
			const audio = msg.resources?.find((r) => r.type === "audio");
			// The SDK also leaves a raw <audio …/> placeholder in msg.content —
			// drop it so the prompt doesn't carry the tag twice.
			if (audio && text) text = text.replace(/<audio[^>]*\/>/g, "").trim();
			if (audio && !voice.enabled) {
				text = voicePrompt({ key: audio.fileKey, durationMs: audio.durationMs }) + (text ? `\n${text}` : "");
			} else if (audio) {
				void lark.addReaction(msg.messageId, "Get").catch(() => {});
				try {
					const buf = await downloadMessageResource(msg.messageId, audio.fileKey);
					const file = await cacheClipForPlayback(runtime.dir, "lark", audio.fileKey, "opus", buf);
					const result = await voice.transcribe({ audio: buf, format: "opus", durationMs: audio.durationMs });
					let prompt = voicePrompt({ key: audio.fileKey, durationMs: audio.durationMs, transcript: result?.text, file });
					if (voice.canSpeak && voice.outboundMode === "agent") {
						prompt += "\n[voice replies enabled — wrap text in <speak>…</speak> to send it as a voice message]";
					}
					text = prompt + (text ? `\n${text}` : "");
				} catch (err) {
					console.error(`[lark] voice transcription failed for ${chatId}:`, errorMessage(err));
					await lark
						.send(chatId, { text: `⚠️ Voice transcription failed: ${errorMessage(err)}` }, sendOpts(msg))
						.catch(() => {});
					text = voicePrompt({ key: audio.fileKey, durationMs: audio.durationMs }) + (text ? `\n${text}` : "");
				}
			}

			if (!text) return;

			// Instant read-receipt — a "收到" (Get) reaction says "received" without
			// waiting on the LLM turn. Fire-and-forget: a failed reaction is fine.
			void lark.addReaction(msg.messageId, "Get").catch(() => {});

			try {
				// Stream the reply: post a preview message and edit it as
				// text_delta chunks arrive (im.v1.message.update is text-only,
				// so the preview is plain text and gets replaced by the final
				// markdown/audio send). Throttled to stay under edit limits.
				let previewId: string | undefined;
				let lastEdit = 0;
				let firstPartialAt: number | undefined;
				let queued: ReturnType<typeof setTimeout> | undefined;
				// Don't create the preview until the stream has been going for a
				// beat — a fast one-word reply would otherwise flash a preview
				// message that gets recalled a second later.
				const PREVIEW_DELAY_MS = 1500;
				const onPartial = (partial: string): void => {
					firstPartialAt ??= Date.now();
					const apply = (): void => {
						lastEdit = Date.now();
						const body = partial.slice(0, 3800) || "…";
						const done = (async () => {
							if (previewId === undefined) {
								const sent = await lark.send(chatId, { text: body }, sendOpts(msg));
								previewId = sent.messageId;
							} else {
								await lark.editMessage(previewId, body);
							}
						})();
						void done.catch(() => {});
					};
					const now = Date.now();
					const wait =
						previewId === undefined
							? PREVIEW_DELAY_MS - (now - firstPartialAt!)
							: 900 - (now - lastEdit);
					if (wait <= 0) {
						clearTimeout(queued);
						queued = undefined;
						apply();
					} else if (!queued) {
						queued = setTimeout(() => {
							queued = undefined;
							apply();
						}, wait);
					}
				};
				const reply = await runtime.deliver(config.workspace, text, provenance("lark", chatId, msg.senderName), { onPartial });
				clearTimeout(queued);
				// The preview is plain text — the final send carries markdown /
				// audio, so drop the preview once the real reply is out.
				const dropPreview = (): void => {
					if (previewId) void lark.recallMessage(previewId).catch(() => {});
					previewId = undefined;
				};
				if (!reply.trim()) {
					dropPreview();
					return;
				}

				// Outbound voice: <speak>…</speak> segments, or the whole reply when
				// the configured mode says this turn should be spoken.
				const spoken = extractSpeakText(reply);
				const speakable = spoken ?? (voice.shouldSpeak({ inboundWasVoice: !!audio }) ? reply : undefined);
				let spoke = false;
				if (speakable) {
					try {
						console.log(`[lark] synthesizing voice reply (${speakable.length} chars)…`);
						const audioBuf = await voice.speak(speakable);
						await lark.send(chatId, { audio: { source: audioBuf } }, sendOpts(msg));
						spoke = true;
						if (!stripSpeakTags(reply).trim()) dropPreview();
						console.log(`[lark] voice reply sent (${audioBuf.length} bytes)`);
					} catch (err) {
						console.error(`[lark] voice reply failed for ${chatId}:`, errorMessage(err));
						await lark
							.send(chatId, { text: `⚠️ Voice reply failed: ${errorMessage(err)}` }, sendOpts(msg))
							.catch(() => {});
					}
				}
				const cleaned = stripSpeakTags(reply).trim();
				// Skip the text copy when it fully duplicates what was just spoken.
				if (cleaned && (!spoke || cleaned !== speakable)) {
					await lark.send(chatId, { markdown: cleaned }, sendOpts(msg));
				}
				dropPreview();
			} catch (err) {
				console.error(`[lark] deliver failed for ${chatId}→${config.workspace}:`, errorMessage(err));
				await lark.send(chatId, { text: failureReply(err) }, sendOpts(msg)).catch((sendErr) => {
					console.error(`[lark] failure reply also failed for ${chatId}:`, errorMessage(sendErr));
				});
			}
		});

		lark.on("error", (err) => console.error("[lark] channel error:", err.message));
		lark.on("reconnecting", () => console.warn("[lark] websocket reconnecting…"));

		await lark.connect();
		console.log(`[lark] connected as ${lark.botIdentity?.name ?? config.appId}`);

		return async () => {
			await lark.disconnect();
		};
	},
} satisfies ChannelAdapter;
