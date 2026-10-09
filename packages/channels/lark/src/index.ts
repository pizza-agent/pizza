/**
 * Lark / Feishu channel relay — a thin adapter on top of channel-core.
 *
 * Receives Feishu/Lark messages over the SDK's WebSocket long connection (no
 * public webhook endpoint needed — stays local-first), hands them to the
 * workspace agent via the gateway with Lark provenance, and posts the agent's
 * reply back into the same chat. Everything else (agent pool, provenance
 * envelope, concurrent-tell serialization, timeouts) lives in channel-core.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-lark
 *   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx PIZZA_WORKSPACE=myrepo \
 *     npm start -w @tomsun28/pizza-channel-lark
 *
 * Env:
 *   LARK_APP_ID / LARK_APP_SECRET  app credentials from the developer console
 *   LARK_DOMAIN                    "feishu" (default) or "lark" for the intl tenant
 *   PIZZA_WORKSPACE                default target workspace for any chat
 *   PIZZA_ROUTES                   "#chatId=workspace,…" per-chat routing (optional)
 *   PIZZA_ANSWER_ALL               "1" to answer every group message (default:
 *                                  only @bot mentions; DMs always answer)
 *
 * The Feishu chat id becomes the provenance id: <message from="lark:oc_xxx">.
 *
 * Setup in the Feishu developer console: enable the bot capability, subscribe
 * to the `im.message.receive_v1` event with "long connection" as the delivery
 * mode, and grant the `im:message` / `im:message:send_as_bot` scopes.
 */

import { Domain, createLarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { ChannelRuntime, parseRoutes, provenance, runChannel } from "@tomsun28/pizza-channel-core";

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");
const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";
const DOMAIN = process.env.LARK_DOMAIN === "lark" ? Domain.Lark : Domain.Feishu;

if (!APP_ID || !APP_SECRET) {
	console.error("Missing LARK_APP_ID / LARK_APP_SECRET (Feishu/Lark developer console → app credentials).");
	process.exit(1);
}
if (!WORKSPACE && Object.keys(ROUTES).length === 0) {
	console.error('Set PIZZA_WORKSPACE (or PIZZA_ROUTES="#oc_xxx=myrepo") so Lark messages have a target.');
	process.exit(1);
}

/** Chat → workspace. PIZZA_ROUTES keys accept the chat id with or without the
 *  leading "#" so the syntax matches the other channels. */
function routeFor(chatId: string): string | undefined {
	return ROUTES[`#${chatId}`] ?? ROUTES[chatId] ?? WORKSPACE;
}

void runChannel(async (runtime: ChannelRuntime) => {
	const lark = createLarkChannel({
		appId: APP_ID,
		appSecret: APP_SECRET,
		domain: DOMAIN,
		transport: "websocket",
		// Group chats require an @mention unless PIZZA_ANSWER_ALL=1; DMs are open.
		policy: { requireMention: !ANSWER_ALL, dmMode: "open" },
	});

	lark.on("message", async (msg: NormalizedMessage) => {
		const chatId = msg.chatId;
		const workspace = routeFor(chatId);
		if (!workspace) return; // no route for this chat

		const text = msg.content.trim();
		if (!text) return;

		try {
			const reply = await runtime.deliver(workspace, text, provenance("lark", chatId, msg.senderName));
			// Reply in-thread so a busy group chat stays readable. The SDK chunks
			// long markdown itself (outbound.textChunkLimit).
			if (reply.trim()) await lark.send(chatId, { markdown: reply }, { replyTo: msg.messageId });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[lark] deliver failed for ${chatId}→${workspace}:`, reason);
			await lark
				.send(chatId, { text: `⚠️ Could not reach the agent (${reason}).` }, { replyTo: msg.messageId })
				.catch(() => {});
		}
	});

	lark.on("error", (err) => console.error("[lark] channel error:", err.message));
	lark.on("reconnecting", () => console.warn("[lark] websocket reconnecting…"));

	await lark.connect();
	console.log(`[lark] connected as ${lark.botIdentity?.name ?? APP_ID}`);

	return async () => {
		await lark.disconnect();
	};
});
