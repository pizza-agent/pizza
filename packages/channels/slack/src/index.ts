/**
 * Slack channel relay — a thin adapter on top of channel-core, using Bolt in
 * Socket Mode (no public webhook endpoint needed — stays local-first, same as
 * the Lark WebSocket transport and Telegram long polling).
 *
 * Receives Slack messages, hands them to the workspace agent via the gateway
 * (with Slack provenance), and posts the agent's reply back in a thread.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-slack
 *   SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… PIZZA_WORKSPACE=myrepo \
 *     npm start -w @tomsun28/pizza-channel-slack
 *
 * Env:
 *   SLACK_BOT_TOKEN    xoxb-… (OAuth & Permissions → Bot User OAuth Token)
 *   SLACK_APP_TOKEN    xapp-… (Basic Information → App-Level Tokens, needs
 *                              the connections:write scope — powers Socket Mode)
 *   PIZZA_WORKSPACE    default target workspace for channels without a route
 *   PIZZA_ROUTES       "#channel=workspace,…" for per-channel routing (optional)
 *   PIZZA_ANSWER_ALL   "1" to reply to every channel message (default: only
 *                      @bot mentions; DMs always answer)
 *   SLACK_PROXY / HTTPS_PROXY / …  route both the Web API and the Socket Mode
 *                      WebSocket through a proxy
 *
 * Slack app setup: enable Socket Mode, create an app-level token with
 * connections:write, subscribe to the app_mention + message.im bot events,
 * grant chat:write / reactions:write / users:read / channels:read (+ groups:read
 * for private channels), then install the app to the workspace.
 */

import https from "node:https";
import { App } from "@slack/bolt";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
	ChannelRuntime,
	parseRoutes,
	provenance,
	runChannel,
} from "@tomsun28/pizza-channel-core";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");
const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";
// slack.com and wss-primary.slack.com are unreachable from some networks —
// honor the standard proxy env vars (the gateway supervisor injects the OS
// proxy when set).
const PROXY =
	process.env.SLACK_PROXY ??
	process.env.HTTPS_PROXY ??
	process.env.https_proxy ??
	process.env.ALL_PROXY ??
	process.env.all_proxy;
const proxyAgent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

if (proxyAgent) {
	// The Socket Mode WebSocket (`ws` package) handshakes via https.request
	// with a pinned `createConnection`, so it ignores agents — patch
	// https.request (read at call time) to route its upgrade through the
	// proxy. Process-local: this adapter only exists to reach Slack. REST
	// (axios) goes through the explicit `agent` App option instead.
	const agent = proxyAgent;
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
	console.log(`[slack] routing API+socket via proxy ${PROXY!.replace(/\/\/[^/@]*@/, "//***@")}`);
}

if (!BOT_TOKEN || !APP_TOKEN) {
	console.error(
		"Missing SLACK_BOT_TOKEN (xoxb-) / SLACK_APP_TOKEN (xapp-). Create them at https://api.slack.com/apps — OAuth & Permissions, and Basic Information → App-Level Tokens.",
	);
	process.exit(1);
}
if (!WORKSPACE && Object.keys(ROUTES).length === 0) {
	console.error("Set PIZZA_WORKSPACE (or PIZZA_ROUTES) so Slack messages have a target.");
	process.exit(1);
}

/** Slack caps a message at ~4000 chars; split long agent replies. */
function chunk(text: string, size = 3900): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

void runChannel(async (runtime: ChannelRuntime) => {
	const app = new App({
		token: BOT_TOKEN,
		appToken: APP_TOKEN,
		socketMode: true,
		...(proxyAgent ? { agent: proxyAgent } : {}),
	});

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
			const info = await app.client.conversations
				.info({ channel: id })
				.catch(() => undefined);
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
			name =
				info?.user?.profile?.display_name ||
				info?.user?.real_name ||
				info?.user?.name ||
				userId;
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
		say: (input: { text: string; thread_ts?: string }) => Promise<unknown>;
	}): Promise<void> {
		const name = input.dm ? "dm" : await channelName(input.channelId);
		const workspace = ROUTES[name] ?? WORKSPACE;
		if (!workspace) return; // no route for this channel

		const text = input.text.replace(/<@[A-Z0-9]+>/g, "").trim(); // strip the @bot mention
		if (!text) return;

		// Instant read-receipt — an 👀 reaction says "received" without waiting
		// on the LLM turn. Fire-and-forget: missing reactions:write is fine.
		void app.client.reactions
			.add({ channel: input.channelId, timestamp: input.ts, name: "eyes" })
			.catch(() => {});

		try {
			const sender = await senderName(input.userId);
			const reply = await runtime.deliver(workspace, text, provenance("slack", name, sender));
			// Reply in a thread so a busy channel stays readable (threading a DM
			// is harmless — Slack just nests it under the message).
			for (const part of chunk(reply)) {
				await input.say({ text: part, thread_ts: input.threadTs ?? input.ts });
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[slack] deliver failed for ${name}→${workspace}:`, reason);
			await input
				.say({ text: `⚠️ Could not reach the agent (${reason}).`, thread_ts: input.threadTs ?? input.ts })
				.catch(() => {});
		}
	}

	// @bot in a channel.
	app.event("app_mention", async ({ event, say }) => {
		await handle({
			channelId: event.channel,
			dm: false,
			userId: event.user,
			text: event.text ?? "",
			ts: event.ts,
			threadTs: "thread_ts" in event ? (event.thread_ts as string | undefined) : undefined,
			say: (m) => say(m),
		});
	});

	// DMs always answer; channels only when ANSWER_ALL (mentions arrive here
	// too — they are already handled by app_mention, so skip them to avoid
	// delivering twice).
	app.message(async ({ event, say }) => {
		const e = event as { channel_type?: string; user?: string; text?: string; ts: string; channel: string; thread_ts?: string };
		const isDm = e.channel_type === "im";
		const isMention = !!e.text?.includes(`<@${botUserId}>`);
		if (!isDm && (!ANSWER_ALL || isMention)) return;
		await handle({
			channelId: e.channel,
			dm: isDm,
			userId: e.user,
			text: e.text ?? "",
			ts: e.ts,
			threadTs: e.thread_ts,
			say: (m) => say(m),
		});
	});

	await app.start();
	return async () => {
		await app.stop();
	};
});
