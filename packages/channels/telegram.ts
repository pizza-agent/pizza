/**
 * Telegram channel adapter, using grammy long polling (no public webhook
 * endpoint needed — stays local-first).
 *
 * Config: `token` from @BotFather. The bot answers in any chat it's added to
 * (and in private DMs). The Telegram chat id becomes the provenance id:
 * <message from="telegram:123456">.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { chunk, errorMessage, failureReply, provenance, proxyFromEnv, redactProxy, routeFetchThroughProxy } from "./runtime.js";
import type { ChannelAdapter } from "./types.js";
import { cacheClipForPlayback, createVoicePipeline, voicePrompt } from "./voice.js";

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
		// Wrap fetch BEFORE importing grammy: module-level bindings capture the
		// fetch reference at import time, so a wrap applied afterwards never
		// reaches it (and a direct connection hangs bot.init() forever).
		const proxy = proxyFromEnv();
		if (proxy) routeFetchThroughProxy(proxy);
		const { Bot } = await import("grammy");
		// grammy defaults to node-fetch, which hangs inside the bundled binary
		// (its agent handling breaks under bunfs). Inject the global fetch —
		// routeFetchThroughProxy already carries proxy credentials on it — and
		// keep the HttpsProxyAgent for non-bundled runtimes.
		const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
		const bot = new Bot(config.token!, {
			client: {
				...(agent ? { baseFetchConfig: { agent } as never } : {}),
				fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init)) as never,
			},
		});
		if (proxy) console.log(`[telegram] routing API via proxy ${redactProxy(proxy)}`);

		// Voice pipeline — no-op unless settings.json has a `voice` section.
		const voice = createVoicePipeline(runtime.dir);

		// Inside the daemon an unhandled middleware error is an uncaughtException
		// — consume it here so a bad update can't kill the gateway.
		bot.catch((err) => console.error("[telegram] handler error:", errorMessage(err)));

		bot.command("start", (ctx) => ctx.reply("I'm a Pizza agent bridge. Send me a message."));

		// Voice messages (and audio files): download via getFile, transcribe
		// when configured, and deliver the transcript like a text message.
		for (const kind of ["voice", "audio"] as const) {
			bot.on(`message:${kind}`, async (ctx) => {
				const chatId = String(ctx.chat.id);
				const clip = ctx.message[kind];
				if (!clip) return;
				const fileKey = clip.file_id;
				const durationMs = clip.duration ? clip.duration * 1000 : undefined;
				const sender =
					[ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
					(ctx.from?.username ? `@${ctx.from.username}` : undefined);
				const prompt = (transcript?: string, file?: string): string =>
					voicePrompt({ key: fileKey, durationMs, transcript, file });

				try {
					await ctx.react("👀").catch(() => {});
					if (!voice.enabled) {
						const reply = await runtime.deliver(config.workspace, prompt(), provenance("telegram", chatId, sender));
						for (const part of chunk(reply, 4000)) await ctx.reply(part);
						return;
					}
					await ctx.replyWithChatAction("typing");
					const file = await ctx.getFile();
					const res = await fetch(
						`https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
						{ signal: AbortSignal.timeout(60_000) },
					);
					if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`);
					const buf = Buffer.from(await res.arrayBuffer());
					const format = file.file_path?.split(".").pop() ?? "oga";
					const cached = await cacheClipForPlayback(runtime.dir, "telegram", fileKey, format, buf);
					const result = await voice.transcribe({ audio: buf, format, durationMs });
					const reply = await runtime.deliver(
						config.workspace,
						prompt(result?.text, cached),
						provenance("telegram", chatId, sender),
					);
					for (const part of chunk(reply, 4000)) await ctx.reply(part);
				} catch (err) {
					console.error(`[telegram] voice handling failed for chat ${chatId}:`, errorMessage(err));
					await ctx.reply(`⚠️ Voice transcription failed: ${errorMessage(err)}`).catch(() => {});
				}
			});
		}

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
				// Stream the reply: edit one preview message as text_delta chunks
				// arrive. Throttled — Telegram rate-limits edits (~1/s per chat is
				// the safe floor); a failed edit just drops that partial.
				let previewId: number | undefined;
				let lastEdit = 0;
				let queued: ReturnType<typeof setTimeout> | undefined;
				const onPartial = (text: string): void => {
					const apply = (): void => {
						lastEdit = Date.now();
						const body = text.slice(0, 4000) || "…";
						const done = (async () => {
							if (previewId === undefined) {
								const sent = await ctx.reply(body);
								previewId = sent.message_id;
							} else {
								await ctx.api.editMessageText(chatId, previewId, body);
							}
						})();
						void done.catch(() => {});
					};
					const wait = 1500 - (Date.now() - lastEdit);
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
				const reply = await runtime.deliver(
					config.workspace,
					ctx.message.text,
					provenance("telegram", chatId, sender),
					{ onPartial },
				);
				clearTimeout(queued);
				// Telegram caps messages at 4096 chars.
				if (previewId !== undefined && reply.length <= 4000) {
					// Reuse the preview message — final markdown/text replaces it.
					await ctx.api.editMessageText(chatId, previewId, reply).catch(async () => {
						for (const part of chunk(reply, 4000)) await ctx.reply(part);
					});
				} else {
					// Long reply (or streaming never produced a preview): drop the
					// partial preview and send the chunked final text.
					if (previewId !== undefined) {
						await ctx.api.deleteMessage(chatId, previewId).catch(() => {});
					}
					for (const part of chunk(reply, 4000)) await ctx.reply(part);
				}
			} catch (err) {
				console.error(`[telegram] deliver failed for chat ${chatId}:`, errorMessage(err));
				await ctx.reply(failureReply(err)).catch(() => {});
			}
		});

		// getMe up front — fails fast on a bad token / unreachable API. Bound
		// it: a hung transport would otherwise leave the adapter configuring
		// forever instead of erroring into the respawn budget.
		await Promise.race([
			bot.init(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("bot.init() timed out after 60s")), 60_000),
			),
		]);
		console.log(`[telegram] logged in as @${bot.botInfo.username}`);

		// bot.start() blocks on the polling loop, so it must NOT be awaited here:
		// the caller only installs signal handlers after start() returns.
		bot.start().catch((err) => {
			console.error("[telegram] polling stopped:", errorMessage(err));
			// Standalone adapter exits (supervisor respawns); inline adapters
			// must not kill the daemon — reportFatal marks the channel crashed.
			runtime.reportFatal(err);
		});

		return async () => {
			await bot.stop();
		};
	},
} satisfies ChannelAdapter;
