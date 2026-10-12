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
import { cacheClip, createVoicePipeline, voicePrompt } from "./voice.js";

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
			const res = await lark.rawClient.im.v1.messageResource.get({
				path: { message_id: messageId, file_key: fileKey },
				params: { type: "file" },
			});
			const stream = res.getReadableStream() as Readable;
			const chunks: Buffer[] = [];
			for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
			return Buffer.concat(chunks);
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
					const file = cacheClip(runtime.dir, "lark", audio.fileKey, "opus", buf);
					const result = await voice.transcribe({ audio: buf, format: "opus", durationMs: audio.durationMs });
					text = voicePrompt({ key: audio.fileKey, durationMs: audio.durationMs, transcript: result?.text, file }) + (text ? `\n${text}` : "");
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
				const reply = await runtime.deliver(config.workspace, text, provenance("lark", chatId, msg.senderName));
				// Reply in-thread so a busy group chat stays readable. The SDK chunks
				// long markdown itself (outbound.textChunkLimit).
				if (reply.trim()) await lark.send(chatId, { markdown: reply }, sendOpts(msg));
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
