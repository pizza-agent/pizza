/**
 * Discord channel relay — a thin adapter on top of channel-core.
 *
 * Receives Discord messages, hands them to the workspace agent via the gateway
 * (with Discord provenance), and posts the agent's reply back. All the heavy
 * lifting (agent pool, provenance envelope, concurrent-tell serialization,
 * timeouts) lives in channel-core / the gateway — this file only knows Discord.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-discord
 *   DISCORD_TOKEN=xxx PIZZA_ROUTES='#dev-alerts=myrepo,#general=myrepo' \
 *     npm start -w @tomsun28/pizza-channel-discord
 *
 * Env:
 *   DISCORD_TOKEN    bot token (https://discord.com/developers/applications)
 *   PIZZA_WORKSPACE  default target workspace for channels without a route
 *   PIZZA_ROUTES     "#channel=workspace,…" — per-channel routing (optional)
 *   PIZZA_ANSWER_ALL set "1" to reply to every message (default: only @bot / DMs)
 *   PIZZA_TELL_TIMEOUT  per-message timeout ms (default 120000)
 */

import https from "node:https";
import { Client, GatewayIntentBits, type Message } from "discord.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import {
	ChannelRuntime,
	parseRoutes,
	provenance,
	runChannel,
} from "@tomsun28/pizza-channel-core";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");
const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";
// discord.com and gateway.discord.gg are unreachable from some networks —
// honor the standard proxy env vars (the gateway supervisor injects the OS
// proxy when set).
const PROXY =
	process.env.DISCORD_PROXY ??
	process.env.HTTPS_PROXY ??
	process.env.https_proxy ??
	process.env.ALL_PROXY ??
	process.env.all_proxy;

if (PROXY) {
	// @discordjs/rest fetches through undici → global dispatcher.
	setGlobalDispatcher(new EnvHttpProxyAgent());
	// The gateway WebSocket (`ws` package) handshakes via https.request with a
	// pinned `createConnection: tlsConnect`, so it ignores agent/globalAgent —
	// and @discordjs/ws never passes options to `new WebSocket()`. Patch
	// https.request (read at call time) to route its upgrade through the proxy
	// agent instead. Process-local: this adapter only exists to reach Discord.
	const agent = new HttpsProxyAgent(PROXY);
	const origRequest = https.request.bind(https);
	const patched: typeof https.request = ((opts: unknown, ...rest: unknown[]) => {
		if (opts && typeof opts === "object" && !Array.isArray(opts) && !(opts instanceof URL)) {
			const options = { ...(opts as https.RequestOptions), agent } as https.RequestOptions & {
				createConnection?: unknown;
			};
			delete options.createConnection;
			return origRequest(options, ...(rest as [never]));
		}
		return (origRequest as (...a: unknown[]) => ReturnType<typeof origRequest>)(opts, ...rest);
	}) as typeof https.request;
	https.request = patched;
	console.log(`[discord] routing API+gateway via proxy ${PROXY.replace(/\/\/[^/@]*@/, "//***@")}`);
}

if (!DISCORD_TOKEN) {
	console.error("Missing DISCORD_TOKEN. Create a bot at https://discord.com/developers/applications.");
	process.exit(1);
}
if (!WORKSPACE && Object.keys(ROUTES).length === 0) {
	console.error('Set PIZZA_WORKSPACE (or PIZZA_ROUTES="#general=myrepo") so Discord messages have a target.');
	process.exit(1);
}

/** Discord caps a message at 2000 chars; split long agent replies. */
function chunk(text: string, size = 1900): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

void runChannel(async (runtime: ChannelRuntime) => {
	const discord = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
	});

	discord.once("ready", () => console.log(`[discord] logged in as ${discord.user?.tag}`));

	discord.on("messageCreate", async (msg: Message) => {
		if (msg.author.bot) return; // never loop on bots

		const channelName = msg.channel.isDMBased() ? "dm" : `#${msg.channel.name ?? "unknown"}`;
		const workspace = ROUTES[channelName] ?? WORKSPACE;
		if (!workspace) return; // no route for this channel

		// Default: answer only @mentions or DMs. ANSWER_ALL replies to everything.
		// mentions.has() also matches mentions of a role the bot holds (users
		// often @ the bot's role, not the user) and replies to the bot's own
		// messages — @everyone stays ignored.
		const isMention = msg.mentions.has(discord.user!, { ignoreEveryone: true });
		if (!ANSWER_ALL && !isMention && !msg.channel.isDMBased()) return;

		const text = msg.content.replace(/<@!?\d+>/g, "").trim(); // strip the @bot mention
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
			const reply = await runtime.deliver(workspace, text, provenance("discord", channelName, sender));
			for (const part of chunk(reply)) await msg.reply(part);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[discord] deliver failed for ${channelName}→${workspace}:`, reason);
			await msg.reply(`⚠️ Could not reach the agent (${reason}).`).catch(() => {});
		} finally {
			clearInterval(typing);
		}
	});

	await discord.login(DISCORD_TOKEN);
	return async () => {
		discord.removeAllListeners();
		await discord.destroy();
	};
});