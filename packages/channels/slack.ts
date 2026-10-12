/**
 * Slack channel adapter, using Bolt in Socket Mode (no public webhook endpoint
 * needed — stays local-first, same as the Lark WebSocket transport and
 * Telegram long polling). Replies are posted in a thread.
 *
 * Config:
 *   token     xoxb-… (OAuth & Permissions → Bot User OAuth Token)
 *   appToken  xapp-… (Basic Information → App-Level Tokens, needs the
 *             connections:write scope — powers Socket Mode)
 * Default: only @bot mentions; DMs always answer. PIZZA_ANSWER_ALL=1 replies
 * to every channel message.
 *
 * Slack app setup: enable Socket Mode, create an app-level token with
 * connections:write, subscribe to the app_mention + message.im bot events,
 * grant chat:write / reactions:write / users:read / channels:read (+ groups:read
 * for private channels), then install the app to the workspace.
 */

import {
	ANSWER_ALL,
	chunk,
	errorMessage,
	failureReply,
	provenance,
	proxyFromEnv,
	redactProxy,
	routeHttpsThroughProxy,
} from "./runtime.js";
import type { ChannelAdapter } from "./types.js";
import { cacheClipForPlayback, createVoicePipeline, voicePrompt } from "./voice.js";

/** Slack file-share entry (subset). Audio uploads and recorded clips both
 *  land here — mimetype "audio/*" or duration_ms marks a voice clip. */
interface SlackFile {
	id: string;
	name?: string;
	mimetype?: string;
	url_private_download?: string;
	duration_ms?: number;
}

export default {
	validate(input) {
		if (!input.token?.trim()) return "Bot token is required";
		if (!input.appToken?.trim()) return "App-level token (xapp-…) is required — enable Socket Mode first";
		return null;
	},

	async probe(config, fetch) {
		const res = await fetch("https://slack.com/api/auth.test", {
			method: "POST",
			headers: { authorization: `Bearer ${config.token}` },
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json()) as { ok?: boolean; error?: string };
		return body.ok === true
			? { ok: true, message: "Bot token is valid" }
			: { ok: false, message: `Slack rejected the token: ${body.error ?? `HTTP ${res.status}`}` };
	},

	async start(config, runtime) {
		// The Socket Mode WebSocket needs the https.request patch; REST (axios)
		// goes through the explicit `agent` App option.
		const proxy = proxyFromEnv();
		const proxyAgent = proxy ? routeHttpsThroughProxy(proxy) : undefined;
		if (proxy) console.log(`[slack] routing API+socket via proxy ${redactProxy(proxy)}`);

		// @slack/bolt is CJS — it has no named ESM exports, so take App off the
		// default export.
		const { App } = (await import("@slack/bolt")).default;
		const app = new App({
			token: config.token,
			appToken: config.appToken,
			socketMode: true,
			...(proxyAgent ? { agent: proxyAgent } : {}),
		});

		// Voice pipeline — no-op unless settings.json has a `voice` section.
		const voice = createVoicePipeline(runtime.dir);

		// auth.test doubles as the fast-fail credential check — a bad token exits
		// here so the supervisor marks the channel "error" instead of "connected".
		const auth = await app.client.auth.test();
		const botUserId = String(auth.user_id);
		console.log(`[slack] connected as ${auth.user} in ${auth.team}`);

		// Small caches — channel names and sender names rarely change.
		const channelNames = new Map<string, string>();
		async function channelName(id: string): Promise<string> {
			let name = channelNames.get(id);
			if (!name) {
				const info = await app.client.conversations.info({ channel: id }).catch(() => undefined);
				const ch = info?.channel;
				name = ch && "name" in ch && ch.name ? `#${ch.name}` : `#${id}`;
				channelNames.set(id, name);
			}
			return name;
		}

		const userNames = new Map<string, string>();
		async function senderName(userId?: string): Promise<string | undefined> {
			if (!userId) return undefined;
			let name = userNames.get(userId);
			if (name === undefined) {
				const info = await app.client.users.info({ user: userId }).catch(() => undefined);
				name = info?.user?.profile?.display_name || info?.user?.real_name || info?.user?.name || userId;
				userNames.set(userId, name);
			}
			return name;
		}

		async function handle(input: {
			channelId: string;
			dm: boolean;
			userId?: string;
			text: string;
			ts: string;
			threadTs?: string;
			files?: SlackFile[];
			say: (input: { text: string; thread_ts?: string }) => Promise<unknown>;
		}): Promise<void> {
			const name = input.dm ? "dm" : await channelName(input.channelId);
			let text = input.text.replace(/<@[A-Z0-9]+>/g, "").trim(); // strip the @bot mention

			// Audio file shares (voice clips, mp3s): download via the bot token
			// and transcribe when a voice provider is configured.
			const clip = input.files?.find(
				(f) => f.mimetype?.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|oga|opus|webm)$/i.test(f.name ?? ""),
			);
			const thread_ts0 = input.threadTs ?? input.ts;
			if (clip && !voice.enabled) {
				text =
					voicePrompt({ key: clip.id, durationMs: clip.duration_ms }) + (text ? `\n${text}` : "");
			} else if (clip?.url_private_download) {
				try {
					const res = await fetch(clip.url_private_download, {
						headers: { authorization: `Bearer ${config.token}` },
						signal: AbortSignal.timeout(60_000),
					});
					if (!res.ok) throw new Error(`file download failed (HTTP ${res.status})`);
					const buf = Buffer.from(await res.arrayBuffer());
					const format = clip.name?.split(".").pop() ?? clip.mimetype?.split("/").pop() ?? "mp4";
					const cached = await cacheClipForPlayback(runtime.dir, "slack", clip.id, format, buf);
					const result = await voice.transcribe({ audio: buf, format, durationMs: clip.duration_ms });
					text =
						voicePrompt({ key: clip.id, durationMs: clip.duration_ms, transcript: result?.text, file: cached }) +
						(text ? `\n${text}` : "");
				} catch (err) {
					console.error(`[slack] voice transcription failed in ${name}:`, errorMessage(err));
					await input
						.say({ text: `⚠️ Voice transcription failed: ${errorMessage(err)}`, thread_ts: thread_ts0 })
						.catch(() => {});
					text = voicePrompt({ key: clip.id, durationMs: clip.duration_ms }) + (text ? `\n${text}` : "");
				}
			}

			if (!text) return;

			// Instant read-receipt — an 👀 reaction says "received" without waiting
			// on the LLM turn. Fire-and-forget: missing reactions:write is fine.
			void app.client.reactions.add({ channel: input.channelId, timestamp: input.ts, name: "eyes" }).catch(() => {});

			// Reply in a thread so a busy channel stays readable (threading a DM
			// is harmless — Slack just nests it under the message).
			const thread_ts = input.threadTs ?? input.ts;
			try {
				const sender = await senderName(input.userId);
				const reply = await runtime.deliver(config.workspace, text, provenance("slack", name, sender));
				for (const part of chunk(reply, 3900)) await input.say({ text: part, thread_ts });
			} catch (err) {
				console.error(`[slack] deliver failed for ${name}→${config.workspace}:`, errorMessage(err));
				await input.say({ text: failureReply(err), thread_ts }).catch(() => {});
			}
		}

		// @bot in a channel.
		app.event("app_mention", async ({ event, say }) => {
			await handle({
				channelId: event.channel,
				dm: false,
				userId: event.user,
				text: event.text ?? "",
				files: (event as { files?: SlackFile[] }).files,
				ts: event.ts,
				threadTs: "thread_ts" in event ? (event.thread_ts as string | undefined) : undefined,
				say: (m) => say(m),
			});
		});

		// DMs always answer; channels only when ANSWER_ALL (mentions arrive here
		// too — they are already handled by app_mention, so skip them to avoid
		// delivering twice).
		app.message(async ({ event, say }) => {
			const e = event as { channel_type?: string; user?: string; text?: string; ts: string; channel: string; thread_ts?: string; files?: SlackFile[] };
			const isDm = e.channel_type === "im";
			const isMention = !!e.text?.includes(`<@${botUserId}>`);
			if (!isDm && (!ANSWER_ALL || isMention)) return;
			await handle({
				channelId: e.channel,
				dm: isDm,
				userId: e.user,
				text: e.text ?? "",
				files: e.files,
				ts: e.ts,
				threadTs: e.thread_ts,
				say: (m) => say(m),
			});
		});

		await app.start();
		return async () => {
			await app.stop();
		};
	},
} satisfies ChannelAdapter;
