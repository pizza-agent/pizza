/**
 * Telegram channel relay — thin adapter on channel-core using grammy.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-telegram
 *   TELEGRAM_BOT_TOKEN=xxx PIZZA_WORKSPACE=myrepo npm start -w @tomsun28/pizza-channel-telegram
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  from @BotFather
 *   PIZZA_WORKSPACE     target workspace (every chat routes here — extend with a
 *                       chat→workspace map if you need per-chat routing)
 *
 * The bot answers in any chat it's added to (and in private DMs). The Telegram
 * chat id becomes the provenance id: <message from="telegram:123456">.
 */

import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ChannelRuntime, provenance, runChannel } from "@tomsun28/pizza-channel-core";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
// api.telegram.org is unreachable from some networks — honor the standard
// proxy env vars (the gateway supervisor injects the OS proxy when set).
const PROXY =
	process.env.TELEGRAM_PROXY ??
	process.env.HTTPS_PROXY ??
	process.env.https_proxy ??
	process.env.ALL_PROXY ??
	process.env.all_proxy;

if (!TOKEN) {
	console.error("Missing TELEGRAM_BOT_TOKEN. Get one from @BotFather.");
	process.exit(1);
}
if (!WORKSPACE) {
	console.error("Missing PIZZA_WORKSPACE (the workspace Telegram chats route to).");
	process.exit(1);
}

void runChannel(async (runtime: ChannelRuntime) => {
	// grammy fetches via node-fetch, so a proxy agent rides in baseFetchConfig.
	const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
	const bot = new Bot(TOKEN, agent ? { client: { baseFetchConfig: { agent } as never } } : undefined);
	if (agent) console.log(`[telegram] routing API via proxy ${PROXY!.replace(/\/\/[^/@]*@/, "//***@")}`);

	bot.command("start", (ctx) => ctx.reply("I'm a Pizza agent bridge. Send me a message."));

	// Every non-command text message → deliver to the agent, reply back.
	bot.on("message:text", async (ctx) => {
		const chatId = String(ctx.chat.id);
		// Sender display name for the envelope's `sender` attr — shown in the
		// UI instead of the raw chat id. Prefer the real name; @username and
		// (for groups) the chat title are useful fallbacks.
		const sender =
			[ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
			(ctx.from?.username ? `@${ctx.from.username}` : undefined) ||
			(ctx.chat.type !== "private" && "title" in ctx.chat ? ctx.chat.title : undefined);
		try {
			// Telegram lets us show "typing…" while the agent works.
			await ctx.replyWithChatAction("typing");
			const reply = await runtime.deliver(WORKSPACE, ctx.message.text, provenance("telegram", chatId, sender));
			// Telegram caps messages at 4096 chars; grammy splits automatically via { Entities }.
			for (const part of chunk(reply, 4000)) await ctx.reply(part);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[telegram] deliver failed for chat ${chatId}:`, reason);
			await ctx.reply(`⚠️ Could not reach the agent (${reason}).`).catch(() => {});
		}
	});

	// getMe up front — fails fast on a bad token / unreachable API.
	await bot.init();
	console.log(`[telegram] logged in as @${bot.botInfo.username}`);

	// Long polling — no public webhook endpoint needed (stays local-first).
	// bot.start() blocks on the polling loop, so it must NOT be awaited here:
	// runChannel only installs signal handlers after this factory returns.
	bot.start().catch((err) => {
		console.error("[telegram] polling stopped:", err instanceof Error ? err.message : err);
		process.exit(1);
	});

	return async () => {
		await bot.stop();
	};
});

function chunk(text: string, size = 4000): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}