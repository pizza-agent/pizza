import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import type { AgentMessage } from "../../src/core/agent/types.js";
import type { SessionFacade } from "../../src/core/session/session-facade.js";
import { mapTypedEventToModeEvents } from "../../src/modes/event-mapper.js";

export interface GuiModeOptions {
	cwd: string;
	host?: string;
	port?: number;
	initialMessage?: string;
	initialImages?: Array<{ type: "image"; data: string; mime_type?: string; mimeType?: string }>;
}

interface GuiState {
	cwd: string;
	sessionId: string;
	model: {
		provider: string;
		modelId: string;
		displayName?: string;
	} | null;
	thinkingLevel: string;
	isRunning: boolean;
	messageCount: number;
	toolCount: number;
}

interface SseClient {
	id: number;
	res: ServerResponse;
}

export async function runGuiModeWithFacade(facade: SessionFacade, options: GuiModeOptions): Promise<never> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const clients = new Map<number, SseClient>();
	let nextClientId = 1;
	let shuttingDown = false;

	const broadcast = (event: string, data: unknown): void => {
		for (const client of clients.values()) {
			writeSse(client.res, event, data);
		}
	};

	const unsubscribe = facade.subscribe((event) => {
		for (const modeEvent of mapTypedEventToModeEvents(event)) {
			broadcast("mode_event", modeEvent);
		}
		if (shouldBroadcastState(event.type)) {
			broadcast("state", getGuiState(facade, options.cwd));
		}
	});

	const server = createServer((req, res) => {
		void handleRequest(req, res, {
			facade,
			cwd: options.cwd,
			host,
			clients,
			nextClientId: () => nextClientId++,
		});
	});

	await listen(server, port, host);
	const address = server.address() as AddressInfo;
	const url = `http://${host}:${address.port}`;
	console.log(`Pizza GUI listening on ${url}`);

	if (options.initialMessage && options.initialMessage.trim().length > 0) {
		void facade.prompt(options.initialMessage, normalizeInitialImages(options.initialImages)).catch((error) => {
			broadcast("server_error", formatError(error));
		});
	}

	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		unsubscribe();
		for (const client of clients.values()) {
			client.res.end();
		}
		clients.clear();
		await closeServer(server);
		facade.dispose();
		process.exit(exitCode);
	};

	const onSigint = () => {
		void shutdown(0);
	};
	const onSigterm = () => {
		void shutdown(143);
	};
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	return new Promise<never>(() => {});
}

/**
 * Hostnames that always identify the local machine.
 */
export function isLoopbackHostname(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Guard against browser-driven cross-origin attacks (CSRF / DNS rebinding).
 *
 * The bridge has no authentication and drives an agent with full shell access,
 * so a page at https://evil.com must not be able to POST to it. Two checks:
 *
 *  - `Host` must name this machine (or the host we were explicitly bound to),
 *    which defeats DNS rebinding (`evil.com` resolving to 127.0.0.1).
 *  - `Origin`, when present, must also be local. Browsers attach `Origin` to
 *    every cross-origin POST, so this rejects the attack while leaving
 *    non-browser clients (curl, scripts) — which send no `Origin` — working.
 *
 * Returns an error string when the request must be refused.
 */
export function checkRequestOrigin(req: IncomingMessage, boundHost: string): string | undefined {
	const allowedHost = boundHost.toLowerCase();

	const hostHeader = req.headers.host;
	if (hostHeader) {
		const hostname = new URL(`http://${hostHeader}`).hostname;
		if (!isLoopbackHostname(hostname) && hostname.toLowerCase() !== allowedHost) {
			return "Invalid Host header";
		}
	}

	const origin = req.headers.origin;
	// Some browsers send the literal "null" origin (sandboxed iframes, file://).
	if (origin && origin !== "null") {
		let originHostname: string;
		try {
			originHostname = new URL(origin).hostname;
		} catch {
			return "Invalid Origin header";
		}
		if (!isLoopbackHostname(originHostname) && originHostname.toLowerCase() !== allowedHost) {
			return "Cross-origin request blocked";
		}
	}

	return undefined;
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	context: {
		facade: SessionFacade;
		cwd: string;
		host: string;
		clients: Map<number, SseClient>;
		nextClientId: () => number;
	},
): Promise<void> {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://localhost");

	const originError = checkRequestOrigin(req, context.host);
	if (originError) {
		sendJson(res, { success: false, error: originError }, 403);
		return;
	}

	try {
		if (method === "GET" && url.pathname === "/") {
			sendHtml(res, INDEX_HTML);
			return;
		}

		if (method === "GET" && url.pathname === "/events") {
			const id = context.nextClientId();
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(": connected\n\n");
			context.clients.set(id, { id, res });
			writeSse(res, "state", getGuiState(context.facade, context.cwd));
			req.on("close", () => {
				context.clients.delete(id);
			});
			return;
		}

		if (method === "GET" && url.pathname === "/api/bootstrap") {
			sendJson(res, {
				state: getGuiState(context.facade, context.cwd),
				messages: getGuiMessages(context.facade),
			});
			return;
		}

		if (method === "POST" && url.pathname === "/api/prompt") {
			const contentTypeError = checkJsonContentType(req);
			if (contentTypeError) {
				sendJson(res, { success: false, error: contentTypeError }, 415);
				return;
			}
			const body = await readJsonBody(req);
			const message = typeof body.message === "string" ? body.message.trim() : "";
			const behavior = body.behavior;
			if (message.length === 0) {
				sendJson(res, { success: false, error: "Message is required" }, 400);
				return;
			}

			if (behavior === "steer") {
				context.facade.steer(message);
			} else if (behavior === "follow_up" || context.facade.isRunning) {
				context.facade.followUp(message);
			} else {
				void context.facade.prompt(message).catch((error) => {
					for (const client of context.clients.values()) {
						writeSse(client.res, "server_error", formatError(error));
					}
				});
			}
			sendJson(res, { success: true });
			return;
		}

		if (method === "POST" && url.pathname === "/api/abort") {
			const contentTypeError = checkJsonContentType(req);
			if (contentTypeError) {
				sendJson(res, { success: false, error: contentTypeError }, 415);
				return;
			}
			context.facade.abort();
			sendJson(res, { success: true });
			return;
		}

		sendJson(res, { success: false, error: "Not found" }, 404);
	} catch (error) {
		sendJson(res, { success: false, error: formatError(error) }, 500);
	}
}

function getGuiState(facade: SessionFacade, cwd: string): GuiState {
	const descriptor = facade.getProjection().getDescriptor();
	const modelConfig = facade.model;
	const model = facade.modelRegistry?.find(modelConfig.provider, modelConfig.model_id);
	const messageCount = facade.getProjection().buildContext().messages.length;
	return {
		cwd,
		sessionId: descriptor.session_id,
		model: {
			provider: modelConfig.provider,
			modelId: modelConfig.model_id,
			displayName: model?.name,
		},
		thinkingLevel: facade.thinkingLevel ?? "off",
		isRunning: facade.isRunning,
		messageCount,
		toolCount: facade.tools.length,
	};
}

function getGuiMessages(facade: SessionFacade): AgentMessage[] {
	return facade.getProjection().buildContext().messages;
}

function shouldBroadcastState(eventType: string): boolean {
	return (
		eventType === "USER_MESSAGE" ||
		eventType === "AGENT_TURN_START" ||
		eventType === "AGENT_TURN_COMPLETED" ||
		eventType === "MODEL_CHANGED" ||
		eventType === "THINKING_LEVEL_CHANGED" ||
		eventType === "SESSION_CREATED"
	);
}

function normalizeInitialImages(
	images?: GuiModeOptions["initialImages"],
): Array<{ type: "image"; data: string; mime_type: string }> | undefined {
	if (!images) return undefined;
	return images.map((image) => ({
		type: "image",
		data: image.data,
		mime_type: image.mime_type ?? image.mimeType ?? "application/octet-stream",
	}));
}

/**
 * Require a JSON content type on state-changing requests.
 *
 * `application/json` is not a CORS-"simple" content type, so a cross-origin
 * browser POST carrying it must first pass a preflight — which our missing
 * CORS headers deny. Without this check an attacker page could POST
 * `text/plain` containing JSON and skip the preflight entirely.
 */
export function checkJsonContentType(req: IncomingMessage): string | undefined {
	const raw = req.headers["content-type"];
	if (!raw) return "Content-Type: application/json is required";
	const mime = raw.split(";", 1)[0]!.trim().toLowerCase();
	if (mime !== "application/json") {
		return "Content-Type: application/json is required";
	}
	return undefined;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 1024 * 1024) {
				req.destroy(new Error("Request body too large"));
			}
		});
		req.on("end", () => {
			if (!body.trim()) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(body);
				resolve(isRecord(parsed) ? parsed : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(html);
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(payload));
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\n`);
	const json = JSON.stringify(data);
	for (const line of json.split("\n")) {
		res.write(`data: ${line}\n`);
	}
	res.write("\n");
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Pizza GUI</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f4f6fa;
			--panel: #ffffff;
			--panel-alt: #eef2f7;
			--line: #d8dee8;
			--line-strong: #bac5d3;
			--text: #101820;
			--muted: #657386;
			--soft: #7a8798;
			--accent: #0f766e;
			--accent-strong: #0b5f59;
			--warn: #b7791f;
			--danger: #b42318;
			--shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
			font-family:
				Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		* {
			box-sizing: border-box;
		}

		html,
		body {
			width: 100%;
			height: 100%;
			margin: 0;
			background: var(--bg);
			color: var(--text);
		}

		body {
			overflow: hidden;
		}

		button,
		textarea {
			font: inherit;
		}

		button {
			border: 1px solid var(--line);
			background: var(--panel);
			color: var(--text);
			min-height: 36px;
			padding: 0 12px;
			border-radius: 6px;
			cursor: pointer;
		}

		button:hover {
			border-color: var(--line-strong);
		}

		button:disabled {
			color: var(--soft);
			cursor: not-allowed;
			background: #f7f8fa;
		}

		.primary {
			background: var(--accent);
			border-color: var(--accent);
			color: white;
		}

		.primary:hover {
			background: var(--accent-strong);
			border-color: var(--accent-strong);
		}

		.danger {
			color: var(--danger);
		}

		.app {
			display: grid;
			grid-template-rows: 56px 1fr auto;
			height: 100vh;
		}

		.topbar {
			display: grid;
			grid-template-columns: minmax(220px, 1fr) auto;
			align-items: center;
			gap: 16px;
			padding: 0 20px;
			border-bottom: 1px solid var(--line);
			background: rgba(255, 255, 255, 0.88);
			backdrop-filter: blur(14px);
		}

		.brand {
			display: flex;
			align-items: center;
			gap: 12px;
			min-width: 0;
		}

		.logo {
			width: 28px;
			height: 28px;
			border-radius: 7px;
			background:
				linear-gradient(135deg, #0f766e 0%, #0f766e 50%, transparent 50%),
				linear-gradient(315deg, #b7791f 0%, #b7791f 50%, #101820 50%);
			box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.42);
			flex: 0 0 auto;
		}

		.title {
			font-weight: 700;
			line-height: 1;
		}

		.path {
			color: var(--muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			max-width: 66vw;
			margin-top: 3px;
		}

		.meta {
			display: flex;
			align-items: center;
			gap: 8px;
			justify-content: flex-end;
			min-width: 0;
		}

		.pill {
			display: inline-flex;
			align-items: center;
			height: 28px;
			padding: 0 9px;
			border: 1px solid var(--line);
			border-radius: 999px;
			background: var(--panel);
			color: var(--muted);
			font-size: 12px;
			max-width: 220px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.pill.running {
			color: var(--accent);
			border-color: rgba(15, 118, 110, 0.35);
			background: rgba(15, 118, 110, 0.08);
		}

		.timeline-wrap {
			overflow: hidden;
			display: grid;
			grid-template-columns: minmax(0, 920px);
			justify-content: center;
			padding: 22px 18px;
		}

		.timeline {
			overflow: auto;
			padding: 0 2px 120px;
			scroll-behavior: smooth;
		}

		.empty {
			min-height: calc(100vh - 220px);
			display: grid;
			align-content: center;
			justify-items: center;
			gap: 10px;
			color: var(--muted);
			text-align: center;
		}

		.empty-title {
			color: var(--text);
			font-size: 24px;
			font-weight: 720;
			letter-spacing: 0;
		}

		.item {
			margin: 0 0 12px;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: var(--panel);
			box-shadow: var(--shadow);
			overflow: hidden;
		}

		.item.user {
			background: #101820;
			color: white;
			border-color: #101820;
		}

		.item.assistant {
			background: var(--panel);
		}

		.item.tool,
		.item.system {
			box-shadow: none;
			background: rgba(255, 255, 255, 0.72);
		}

		.item-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			min-height: 38px;
			padding: 9px 12px;
			border-bottom: 1px solid var(--line);
			color: var(--muted);
			font-size: 12px;
		}

		.user .item-head {
			border-bottom-color: rgba(255, 255, 255, 0.14);
			color: rgba(255, 255, 255, 0.72);
		}

		.item-title {
			font-weight: 700;
			color: inherit;
		}

		.item-status {
			color: var(--soft);
			white-space: nowrap;
		}

		.item-body {
			padding: 13px 14px 15px;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			line-height: 1.5;
			font-size: 14px;
		}

		.item-body:empty::after {
			content: " ";
		}

		.tool .item-body {
			display: grid;
			grid-template-columns: minmax(96px, auto) 1fr;
			gap: 8px 12px;
			align-items: start;
			white-space: normal;
		}

		.tool-name {
			color: var(--muted);
			font-size: 12px;
			font-weight: 700;
			text-transform: uppercase;
		}

		.tool-label {
			min-width: 0;
			overflow-wrap: anywhere;
		}

		details {
			grid-column: 1 / -1;
			color: var(--muted);
			font-size: 12px;
		}

		summary {
			cursor: pointer;
		}

		pre {
			margin: 8px 0 0;
			padding: 10px;
			max-height: 260px;
			overflow: auto;
			border-radius: 6px;
			background: #111827;
			color: #e5e7eb;
			font-size: 12px;
			line-height: 1.45;
		}

		.composer {
			border-top: 1px solid var(--line);
			background: rgba(255, 255, 255, 0.92);
			backdrop-filter: blur(14px);
			padding: 14px 18px 18px;
			display: grid;
			grid-template-columns: minmax(0, 920px);
			justify-content: center;
		}

		.composer-inner {
			display: grid;
			grid-template-columns: 1fr auto auto;
			gap: 10px;
			align-items: end;
		}

		textarea {
			width: 100%;
			min-height: 48px;
			max-height: 180px;
			resize: vertical;
			padding: 12px;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: var(--panel);
			color: var(--text);
			line-height: 1.45;
			outline: none;
		}

		textarea:focus {
			border-color: rgba(15, 118, 110, 0.52);
			box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
		}

		.error-line {
			margin-top: 8px;
			color: var(--danger);
			font-size: 12px;
			min-height: 16px;
		}

		@media (max-width: 720px) {
			.app {
				grid-template-rows: auto 1fr auto;
			}

			.topbar {
				grid-template-columns: 1fr;
				align-items: start;
				padding: 12px 14px;
			}

			.meta {
				justify-content: flex-start;
				flex-wrap: wrap;
			}

			.path {
				max-width: calc(100vw - 86px);
			}

			.timeline-wrap {
				padding: 14px 10px;
			}

			.composer {
				padding: 10px;
			}

			.composer-inner {
				grid-template-columns: 1fr;
			}

			button {
				width: 100%;
			}

			.tool .item-body {
				grid-template-columns: 1fr;
			}
		}
	</style>
</head>
<body>
	<div id="app" class="app">
		<header class="topbar">
			<div class="brand">
				<div class="logo" aria-hidden="true"></div>
				<div>
					<div class="title">Pizza</div>
					<div id="projectPath" class="path"></div>
				</div>
			</div>
			<div class="meta">
				<span id="modelPill" class="pill"></span>
				<span id="statusPill" class="pill"></span>
				<button id="stopButton" class="danger" type="button" disabled>Stop</button>
			</div>
		</header>
		<main class="timeline-wrap">
			<div id="timeline" class="timeline"></div>
		</main>
		<footer class="composer">
			<form id="composerForm" class="composer-inner">
				<textarea id="promptInput" placeholder="Ask Pizza to work on this project"></textarea>
				<button id="followButton" type="button">Follow up</button>
				<button id="sendButton" class="primary" type="submit">Send</button>
			</form>
			<div id="errorLine" class="error-line"></div>
		</footer>
	</div>
	<script>
		const timeline = document.getElementById("timeline");
		const projectPath = document.getElementById("projectPath");
		const modelPill = document.getElementById("modelPill");
		const statusPill = document.getElementById("statusPill");
		const stopButton = document.getElementById("stopButton");
		const sendButton = document.getElementById("sendButton");
		const followButton = document.getElementById("followButton");
		const promptInput = document.getElementById("promptInput");
		const composerForm = document.getElementById("composerForm");
		const errorLine = document.getElementById("errorLine");

		const state = {
			items: [],
			isRunning: false,
			activeAssistantId: null,
			tools: new Map(),
		};

		function setError(message) {
			errorLine.textContent = message || "";
		}

		function scrollToBottom() {
			timeline.scrollTop = timeline.scrollHeight;
		}

		function messageText(message) {
			if (!message) return "";
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) {
				return message.content
					.map((block) => {
						if (!block || typeof block !== "object") return "";
						if (block.type === "text") return block.text || "";
						if (block.type === "thinking") return "";
						if (block.type === "toolCall") return "Tool call: " + (block.name || "tool");
						if (block.type === "image") return "[image]";
						return "";
					})
					.filter(Boolean)
					.join("\n");
			}
			if (message.role === "bashExecution") {
				return "$ " + message.command + "\n" + (message.output || "");
			}
			if (message.role === "compactionSummary") return message.summary || "";
			if (message.role === "branchSummary") return message.summary || "";
			if (message.role === "custom") return typeof message.display === "string" ? message.display : String(message.content || "");
			return "";
		}

		function pushMessage(message) {
			if (message.role === "toolResult") return;
			if (message.role === "assistant" && state.activeAssistantId) {
				const item = state.items.find((candidate) => candidate.id === state.activeAssistantId);
				if (item) {
					item.text = messageText(message);
					item.status = "Done";
					item.streaming = false;
					state.activeAssistantId = null;
					render();
					return;
				}
			}

			const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
			state.items.push({
				id: "msg-" + Date.now() + "-" + Math.random().toString(16).slice(2),
				type: role,
				title: titleForMessage(message),
				status: formatTime(message.timestamp),
				text: messageText(message),
			});
			render();
		}

		function titleForMessage(message) {
			if (message.role === "user") return "You";
			if (message.role === "assistant") return "Pizza";
			if (message.role === "bashExecution") return "Command";
			if (message.role === "compactionSummary") return "Compaction";
			if (message.role === "branchSummary") return "Branch";
			return "System";
		}

		function formatTime(timestamp) {
			if (!timestamp) return "";
			return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}

		function handleModeEvent(event) {
			switch (event.type) {
				case "message_committed":
					pushMessage(event.message);
					break;
				case "streaming_message_started":
					state.activeAssistantId = event.eventId;
					state.items.push({
						id: event.eventId,
						type: "assistant",
						title: "Pizza",
						status: "Streaming",
						text: "",
						streaming: true,
					});
					render();
					break;
				case "streaming_message_updated": {
					if (!state.activeAssistantId) return;
					const item = state.items.find((candidate) => candidate.id === state.activeAssistantId);
					if (item && event.delta) {
						item.text += event.delta;
						render();
					}
					break;
				}
				case "tool_started":
					upsertTool(event.toolCallId, {
						id: event.toolCallId,
						type: "tool",
						title: "Tool",
						status: "Running",
						name: event.toolName,
						label: toolLabel(event.toolName, event.args),
						details: event.args,
					});
					break;
				case "tool_updated":
					updateTool(event.toolCallId, { status: "Running", update: event.update });
					break;
				case "tool_finished":
					updateTool(event.toolCallId, {
						status: event.isError ? "Error" : "Done",
						result: event.result,
						isError: event.isError,
					});
					break;
				case "turn_started":
					state.isRunning = true;
					renderMeta();
					break;
				case "turn_completed":
					state.isRunning = false;
					if (event.reason === "loop_detected") {
						state.items.push({
							id: event.eventId,
							type: "system",
							title: "Loop detected",
							status: "",
							text: "Agent stopped: repeated identical tool calls detected (possible loop). Send a message to continue.",
						});
					}
					renderMeta();
					break;
				case "runtime_error":
				case "agent_error":
					setError(event.error);
					state.items.push({
						id: event.eventId,
						type: "system",
						title: "Error",
						status: "",
						text: event.error,
					});
					render();
					break;
			}
		}

		function upsertTool(id, data) {
			const existing = state.items.find((item) => item.id === id);
			if (existing) {
				Object.assign(existing, data);
			} else {
				state.items.push(data);
			}
			state.tools.set(id, data);
			render();
		}

		function updateTool(id, patch) {
			const item = state.items.find((candidate) => candidate.id === id);
			if (!item) return;
			Object.assign(item, patch);
			render();
		}

		function toolLabel(name, args) {
			const value = (...keys) => {
				for (const key of keys) {
					if (args && args[key] !== undefined && args[key] !== null && String(args[key]).length > 0) {
						return String(args[key]);
					}
				}
				return "";
			};
			switch (name) {
				case "read":
					return value("path", "file_path", "file") || "Read file";
				case "write":
					return value("path", "file_path", "file") || "Write file";
				case "edit":
					return value("path", "file_path", "file") || "Edit file";
				case "bash":
					return value("command", "cmd") || "Run command";
				case "grep":
					return value("pattern", "query") || "Search code";
				case "find":
					return value("pattern", "path") || "Find files";
				case "ls":
					return value("path", "dir") || "List files";
				default:
					return value("path", "command", "query", "pattern") || name;
			}
		}

		function renderMeta(meta) {
			if (meta) {
				state.meta = meta;
				state.isRunning = meta.isRunning;
			}
			const current = state.meta || {};
			projectPath.textContent = current.cwd || "";
			const model = current.model;
			modelPill.textContent = model ? model.provider + "/" + model.modelId : "No model";
			statusPill.textContent = state.isRunning ? "Running" : "Idle";
			statusPill.classList.toggle("running", state.isRunning);
			stopButton.disabled = !state.isRunning;
			sendButton.textContent = state.isRunning ? "Queue" : "Send";
		}

		function render() {
			if (state.items.length === 0) {
				timeline.innerHTML =
					'<div class="empty"><div class="empty-title">Pizza GUI</div><div>Current project is ready.</div></div>';
				renderMeta();
				return;
			}
			timeline.innerHTML = state.items.map(renderItem).join("");
			renderMeta();
			scrollToBottom();
		}

		function renderItem(item) {
			if (item.type === "tool") {
				const status = escapeHtml(item.status || "");
				const details = item.details ? renderDetails("Arguments", item.details) : "";
				const result = item.result !== undefined ? renderDetails(item.isError ? "Error output" : "Result", item.result) : "";
				const update = item.update ? '<details><summary>Update</summary><pre>' + escapeHtml(item.update) + "</pre></details>" : "";
				return (
					'<section class="item tool">' +
					'<div class="item-head"><span class="item-title">' +
					escapeHtml(item.name || "tool") +
					'</span><span class="item-status">' +
					status +
					"</span></div>" +
					'<div class="item-body"><div class="tool-name">Target</div><div class="tool-label">' +
					escapeHtml(item.label || "") +
					"</div>" +
					update +
					details +
					result +
					"</div></section>"
				);
			}

			return (
				'<section class="item ' +
				escapeHtml(item.type) +
				'"><div class="item-head"><span class="item-title">' +
				escapeHtml(item.title || "") +
				'</span><span class="item-status">' +
				escapeHtml(item.status || "") +
				'</span></div><div class="item-body">' +
				escapeHtml(item.text || "") +
				"</div></section>"
			);
		}

		function renderDetails(label, data) {
			return (
				"<details><summary>" +
				escapeHtml(label) +
				"</summary><pre>" +
				escapeHtml(JSON.stringify(data, null, 2)) +
				"</pre></details>"
			);
		}

		function escapeHtml(value) {
			return String(value)
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll('"', "&quot;")
				.replaceAll("'", "&#039;");
		}

		async function postJson(url, body) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			const payload = await response.json();
			if (!response.ok || payload.success === false) {
				throw new Error(payload.error || "Request failed");
			}
			return payload;
		}

		composerForm.addEventListener("submit", async (event) => {
			event.preventDefault();
			const message = promptInput.value.trim();
			if (!message) return;
			setError("");
			promptInput.value = "";
			try {
				await postJson("/api/prompt", { message });
			} catch (error) {
				setError(error.message);
				promptInput.value = message;
			}
		});

		followButton.addEventListener("click", async () => {
			const message = promptInput.value.trim();
			if (!message) return;
			setError("");
			promptInput.value = "";
			try {
				await postJson("/api/prompt", { message, behavior: "follow_up" });
			} catch (error) {
				setError(error.message);
				promptInput.value = message;
			}
		});

		stopButton.addEventListener("click", async () => {
			setError("");
			try {
				await postJson("/api/abort", {});
			} catch (error) {
				setError(error.message);
			}
		});

		promptInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				composerForm.requestSubmit();
			}
		});

		async function start() {
			const response = await fetch("/api/bootstrap");
			const payload = await response.json();
			renderMeta(payload.state);
			state.items = [];
			for (const message of payload.messages || []) {
				pushMessage(message);
			}
			render();

			const events = new EventSource("/events");
			events.addEventListener("state", (event) => renderMeta(JSON.parse(event.data)));
			events.addEventListener("mode_event", (event) => handleModeEvent(JSON.parse(event.data)));
			events.addEventListener("server_error", (event) => {
				try {
					setError(JSON.parse(event.data));
				} catch {
					setError(event.data);
				}
			});
			events.onerror = () => {
				setError("Connection lost. Refresh when the server is back.");
			};
		}

		start().catch((error) => {
			setError(error.message);
			render();
		});
	</script>
</body>
</html>`;
