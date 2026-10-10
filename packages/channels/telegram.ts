/**
 * Telegram channel adapter, using grammy long polling (no public webhook
 * endpoint needed — stays local-first).
 *
 * Config: `token` from @BotFather. The bot answers in any chat it's added to
 * (and in private DMs). The Telegram chat id becomes the provenance id:
 * <message from="telegram:123456">.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { chunk, errorMessage, failureReply, provenance, proxyFromEnv, redactProxy } from "./runtime.js";
import type { ChannelAdapter } from "./types.js";

export default {
	validate: (input) => (input.token?.trim() ? null : "Bot token is required"),

	async probe(config, fetch) {
		const res = await fetch(`https://api.telegram.org/bot${config.token}/getMe`, {
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json()) as { ok?: boolean; description?: string };
		return body.ok === true
			? { ok: true, message: "Bot token is valid" }
			: { ok: false, message: `Telegram rejected the token: ${body.description ?? `HTTP ${res.status}`}` };
	},

	async start(config, runtime) {
		const { Bot } = await import("grammy");
		// grammy fetches via node-fetch, so a proxy agent rides in baseFetchConfig.
		const proxy = proxyFromEnv();
		const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
		const bot = new Bot(config.token!, agent ? { client: { baseFetchConfig: { agent } as never } } : undefined);
		if (proxy) console.log(`[telegram] routing API via proxy ${redactProxy(proxy)}`);

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
				// Instant read-receipt — a 👀 reaction says "received" without waiting
				// on the LLM turn. Fire-and-forget: a failed reaction is fine.
				await ctx.react("👀").catch(() => {});
				// Telegram lets us show "typing…" while the agent works.
				await ctx.replyWithChatAction("typing");
				const reply = await runtime.deliver(config.workspace, ctx.message.text, provenance("telegram", chatId, sender));
				// Telegram caps messages at 4096 chars.
				for (const part of chunk(reply, 4000)) await ctx.reply(part);
			} catch (err) {
				console.error(`[telegram] deliver failed for chat ${chatId}:`, errorMessage(err));
				await ctx.reply(failureReply(err)).catch(() => {});
			}
		});

		// getMe up front — fails fast on a bad token / unreachable API.
		await bot.init();
		console.log(`[telegram] logged in as @${bot.botInfo.username}`);

		// bot.start() blocks on the polling loop, so it must NOT be awaited here:
		// the caller only installs signal handlers after start() returns.
		bot.start().catch((err) => {
			console.error("[telegram] polling stopped:", errorMessage(err));
			process.exit(1);
		});

		return async () => {
			await bot.stop();
		};
	},
} satisfies ChannelAdapter;
