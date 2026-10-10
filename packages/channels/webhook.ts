/**
 * Webhook channel adapter — a generic HTTP endpoint that delivers inbound POSTs
 * into a workspace agent and returns the agent's reply as JSON. No external SDK,
 * so it's the simplest channel and a good reference for the others.
 *
 * Config: `webhookUrl` is the address to listen on (default 127.0.0.1:3002 —
 * localhost only; use 0.0.0.0 to accept webhooks from other machines).
 * Optional `token` is a shared secret; requests must then send
 * `authorization: Bearer <token>` (or ?token=<token>).
 *
 * Test:
 *   curl -s localhost:3002/ \
 *     -H 'content-type: application/json' \
 *     -H 'authorization: Bearer secret' \
 *     -d '{"message":"summarize the last commit","source":"ci-bot"}'
 *   → { "reply": "..." }
 *
 * Request body:
 *   { "message": "...", "workspace"?: "...", "source"?: "...", "sender"?: "..." }
 * `source` becomes the provenance id (<message from="webhook:ci-bot">) and the
 * optional `sender` the human-readable name shown on the message card.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { errorMessage, provenance, type MessageSource } from "./runtime.js";
import type { ChannelAdapter, ChannelConfig } from "./types.js";

/** Inbound bodies bigger than this are rejected — this is an open HTTP endpoint. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServerOptions {
	/** Shared secret; when set every request must authenticate. */
	token?: string;
	/** Fallback workspace for bodies without `workspace`. */
	defaultWorkspace: string;
	/** Route a message into the agent and resolve with its reply. */
	deliver: (workspace: string, message: string, source: MessageSource) => Promise<string>;
}

/** Where the webhook listens, derived from `webhookUrl`. */
export function listenAddress(config: Pick<ChannelConfig, "webhookUrl">): { host: string; port: number } {
	try {
		const url = new URL(config.webhookUrl ?? "");
		return { host: url.hostname || "127.0.0.1", port: url.port ? Number(url.port) : 3002 };
	} catch {
		return { host: "127.0.0.1", port: 3002 };
	}
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(c as Buffer);
	}
	try {
		return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
	} catch {
		throw new Error("invalid JSON body");
	}
}

/** The request handler, exported so tests can drive it without a gateway. */
export function createWebhookServer(opts: WebhookServerOptions): Server {
	return createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		try {
			if (req.method !== "POST") {
				res.writeHead(405);
				return res.end(JSON.stringify({ error: "POST only" }));
			}
			// Optional shared-secret guard.
			if (opts.token) {
				const auth = req.headers.authorization ?? "";
				const url = new URL(req.url ?? "/", "http://localhost");
				const got = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
				if (got !== opts.token) {
					res.writeHead(401);
					return res.end(JSON.stringify({ error: "unauthorized" }));
				}
			}

			let body: Record<string, unknown>;
			try {
				body = await readJson(req);
			} catch (err) {
				const reason = errorMessage(err);
				res.writeHead(reason === "body too large" ? 413 : 400);
				return res.end(JSON.stringify({ error: reason }));
			}
			const message = typeof body.message === "string" ? body.message : "";
			if (!message) {
				res.writeHead(400);
				return res.end(JSON.stringify({ error: "missing 'message'" }));
			}
			const workspace = typeof body.workspace === "string" ? body.workspace : opts.defaultWorkspace;
			const sourceId = typeof body.source === "string" && body.source ? body.source : "webhook";
			const sender = typeof body.sender === "string" && body.sender ? body.sender : undefined;

			const reply = await opts.deliver(workspace, message, provenance("webhook", sourceId, sender));
			res.writeHead(200);
			res.end(JSON.stringify({ reply }));
		} catch (err) {
			const reason = errorMessage(err);
			console.error("[webhook] request failed:", reason);
			res.writeHead(502);
			res.end(JSON.stringify({ error: reason }));
		}
	});
}

export default {
	validate: (input) => (input.webhookUrl?.trim() ? null : "Webhook URL is required"),

	// No remote credentials to check — "can we listen" is the test.
	async probe(config) {
		try {
			new URL(config.webhookUrl ?? "");
		} catch {
			return { ok: false, message: "Webhook URL is not a valid URL" };
		}
		const { host, port } = listenAddress(config);
		try {
			await new Promise<void>((resolve, reject) => {
				const probe = createServer();
				probe.once("error", reject);
				probe.listen(port, host, () => probe.close(() => resolve()));
			});
			return { ok: true, message: `Webhook will listen on ${host}:${port}` };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
				return { ok: true, message: `${host}:${port} is already listening` };
			}
			return { ok: false, message: `Cannot listen on ${host}:${port}: ${errorMessage(err)}` };
		}
	},

	async start(config, runtime) {
		const { host, port } = listenAddress(config);
		const server = createWebhookServer({
			token: config.token || undefined,
			defaultWorkspace: config.workspace,
			deliver: (workspace, message, source) => runtime.deliver(workspace, message, source),
		});
		await new Promise<void>((resolve) => server.listen(port, host, resolve));
		console.log(`[webhook] listening on http://${host}:${port} → workspace "${config.workspace}"`);
		return async () => await new Promise<void>((resolve) => server.close(() => resolve()));
	},
} satisfies ChannelAdapter;
