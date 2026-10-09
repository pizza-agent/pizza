/**
 * Webhook channel relay — a generic HTTP endpoint that delivers inbound POSTs
 * into a workspace agent and returns the agent's reply as JSON. No external SDK,
 * so it's the simplest channel and a good reference for the others.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-webhook
 *   PIZZA_WORKSPACE=myrepo WEBHOOK_TOKEN=secret npm start -w @tomsun28/pizza-channel-webhook
 *
 * Test:
 *   curl -s localhost:3002/ \
 *     -H 'content-type: application/json' \
 *     -H 'authorization: Bearer secret' \
 *     -d '{"message":"summarize the last commit","source":"ci-bot"}'
 *   → { "reply": "..." }
 *
 * Env:
 *   PORT            listen port (default 3002)
 *   WEBHOOK_HOST    bind address (default 127.0.0.1 — localhost only; set
 *                   0.0.0.0 to accept webhooks from other machines)
 *   PIZZA_WORKSPACE default target workspace when the body omits `workspace`
 *   WEBHOOK_TOKEN   optional shared secret; if set, requests must send
 *                   `authorization: Bearer <token>` (or ?token=<token>)
 *
 * Request body:
 *   { "message": "...", "workspace"?: "...", "source"?: "...", "sender"?: "..." }
 * `source` becomes the provenance id (<message from="webhook:ci-bot">) and the
 * optional `sender` the human-readable name shown on the message card.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelRuntime, provenance, runChannel, type MessageSource } from "@tomsun28/pizza-channel-core";

const PORT = Number(process.env.PORT ?? 3002);
const HOST = process.env.WEBHOOK_HOST ?? "127.0.0.1";
const DEFAULT_WORKSPACE = process.env.PIZZA_WORKSPACE;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
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
				const reason = err instanceof Error ? err.message : String(err);
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
			const reason = err instanceof Error ? err.message : String(err);
			console.error("[webhook] request failed:", reason);
			res.writeHead(502);
			res.end(JSON.stringify({ error: reason }));
		}
	});
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) {
	if (!DEFAULT_WORKSPACE) {
		console.error("Missing PIZZA_WORKSPACE (the default workspace inbound webhooks route to).");
		process.exit(1);
	}

	void runChannel(async (runtime: ChannelRuntime) => {
		const server = createWebhookServer({
			token: WEBHOOK_TOKEN || undefined,
			defaultWorkspace: DEFAULT_WORKSPACE,
			deliver: (workspace, message, source) => runtime.deliver(workspace, message, source),
		});

		await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
		console.log(`[webhook] listening on http://${HOST}:${PORT} → workspace "${DEFAULT_WORKSPACE}"`);
		return async () => await new Promise<void>((resolve) => server.close(() => resolve()));
	});
}
