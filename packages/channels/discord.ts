/**
 * Discord channel adapter — receives Discord messages, hands them to the
 * workspace agent via the gateway (with Discord provenance), and posts the
 * agent's reply back. All the heavy lifting (agent pool, provenance envelope,
 * concurrent-tell serialization, timeouts) lives in the runtime / the gateway —
 * this file only knows Discord.
 *
 * Config: `token` (bot token, https://discord.com/developers/applications).
 * Default: answer only @mentions or DMs; PIZZA_ANSWER_ALL=1 replies to everything.
 */

import type { Attachment, Message } from "discord.js";
import { ANSWER_ALL, chunk, failureReply, errorMessage, provenance, proxyFromEnv, redactProxy, routeHttpsThroughProxy } from "./runtime.js";
import type { ChannelAdapter } from "./types.js";
import { createVoicePipeline, voicePrompt } from "./voice.js";

/** First audio-ish attachment on a message — voice messages and uploaded
 *  audio files alike. `duration_secs` is only present on real voice clips. */
function audioAttachment(msg: Message): Attachment | undefined {
	for (const att of msg.attachments.values()) {
		if (att.contentType?.startsWith("audio/")) return att;
	}
	return undefined;
}

export default {
	validate: (input) => (input.token?.trim() ? null : "Bot token is required"),

	async probe(config, fetch) {
		const res = await fetch("https://discord.com/api/v10/users/@me", {
			headers: { authorization: `Bot ${config.token}` },
			signal: AbortSignal.timeout(10_000),
		});
		return res.ok
			? { ok: true, message: "Bot token is valid" }
			: { ok: false, message: `Discord rejected the token (HTTP ${res.status})` };
	},

	async start(config, runtime) {
		// REST goes through undici's global dispatcher (EnvHttpProxyAgent, set by
		// the CLI); the gateway WebSocket needs the https.request patch.
		const proxy = proxyFromEnv();
		if (proxy) {
			routeHttpsThroughProxy(proxy);
			console.log(`[discord] routing API+gateway via proxy ${redactProxy(proxy)}`);
		}

		const { Client, GatewayIntentBits } = await import("discord.js");
		const discord = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
		});

		discord.once("ready", () => console.log(`[discord] logged in as ${discord.user?.tag}`));

		// Voice pipeline — no-op unless settings.json has a `voice` section.
		const voice = createVoicePipeline(runtime.dir);

		discord.on("messageCreate", async (msg: Message) => {
			if (msg.author.bot) return; // never loop on bots

			const channelName = msg.channel.isDMBased() ? "dm" : `#${msg.channel.name ?? "unknown"}`;

			// Default: answer only @mentions or DMs. ANSWER_ALL replies to everything.
			// mentions.has() also matches mentions of a role the bot holds (users
			// often @ the bot's role, not the user) and replies to the bot's own
			// messages — @everyone stays ignored.
			const isMention = msg.mentions.has(discord.user!, { ignoreEveryone: true });
			if (!ANSWER_ALL && !isMention && !msg.channel.isDMBased()) return;

			let text = msg.content.replace(/<@!?\d+>/g, "").trim(); // strip the @bot mention

			// Audio attachments (voice messages upload as audio/ogg): transcribe
			// when a voice provider is configured, else forward the placeholder.
			const clip = audioAttachment(msg);
			if (clip && !voice.enabled) {
				text = voicePrompt({ key: clip.id, transcript: undefined }) + (text ? `\n${text}` : "");
			} else if (clip) {
				void msg.react("👀").catch(() => {});
				try {
					const res = await fetch(clip.url, { signal: AbortSignal.timeout(60_000) });
					if (!res.ok) throw new Error(`attachment download failed (HTTP ${res.status})`);
					const buf = Buffer.from(await res.arrayBuffer());
					const format = clip.name?.split(".").pop() ?? "ogg";
					const result = await voice.transcribe({ audio: buf, format });
					text =
						voicePrompt({ key: clip.id, transcript: result?.text }) + (text ? `\n${text}` : "");
				} catch (err) {
					console.error(`[discord] voice transcription failed in ${channelName}:`, errorMessage(err));
					await msg.reply(`⚠️ Voice transcription failed: ${errorMessage(err)}`).catch(() => {});
					text = voicePrompt({ key: clip.id }) + (text ? `\n${text}` : "");
				}
			}

			if (!text) return;

			// Instant read-receipt — a 👀 reaction says "received" without waiting
			// on the LLM turn. Fire-and-forget: a missing reaction perm is fine.
			void msg.react("👀").catch(() => {});

			// Reflect "typing" while the agent works (it may take a while). Not every
			// channel kind can be typed in (e.g. partial group DMs), hence the guard.
			const typeable = msg.channel.isSendable() ? msg.channel : undefined;
			await typeable?.sendTyping().catch(() => {});
			const typing = setInterval(() => void typeable?.sendTyping().catch(() => {}), 8_000);

			try {
				// Sender display name for the envelope's `sender` attr — guild
				// nickname, global display name, or raw username (DMs have no member).
				const sender = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;
				const reply = await runtime.deliver(config.workspace, text, provenance("discord", channelName, sender));
				// Discord caps a message at 2000 chars.
				for (const part of chunk(reply, 1900)) await msg.reply(part);
			} catch (err) {
				console.error(`[discord] deliver failed for ${channelName}→${config.workspace}:`, errorMessage(err));
				await msg.reply(failureReply(err)).catch(() => {});
			} finally {
				clearInterval(typing);
			}
		});

		await discord.login(config.token);
		return async () => {
			discord.removeAllListeners();
			await discord.destroy();
		};
	},
} satisfies ChannelAdapter;
