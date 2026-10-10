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
 * mode, and grant the `im:message` / `im:message:send_as_bot` scopes.
 */

import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { ANSWER_ALL, errorMessage, failureReply, provenance } from "./runtime.js";
import type { ChannelAdapter } from "./types.js";

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
		const lark = createLarkChannel({
			appId: config.appId!,
			appSecret: config.appSecret!,
			domain: process.env.LARK_DOMAIN === "lark" ? Domain.Lark : Domain.Feishu,
			transport: "websocket",
			policy: { requireMention: !ANSWER_ALL, dmMode: "open" },
		});

		lark.on("message", async (msg: NormalizedMessage) => {
			const chatId = msg.chatId;
			const text = msg.content.trim();
			if (!text) return;

			// Instant read-receipt — a "收到" (Get) reaction says "received" without
			// waiting on the LLM turn. Fire-and-forget: a failed reaction is fine.
			void lark.addReaction(msg.messageId, "Get").catch(() => {});

			try {
				const reply = await runtime.deliver(config.workspace, text, provenance("lark", chatId, msg.senderName));
				// Reply in-thread so a busy group chat stays readable. The SDK chunks
				// long markdown itself (outbound.textChunkLimit).
				if (reply.trim()) await lark.send(chatId, { markdown: reply }, { replyTo: msg.messageId });
			} catch (err) {
				console.error(`[lark] deliver failed for ${chatId}→${config.workspace}:`, errorMessage(err));
				await lark.send(chatId, { text: failureReply(err) }, { replyTo: msg.messageId }).catch(() => {});
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
