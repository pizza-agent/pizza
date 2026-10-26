import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Built-in provider id -> display name map.
 *
 * Source of truth: `dist/providers.json`, generated from pi-ai at build time
 * (scripts/generate-providers.mjs). Falls back to importing pi-ai directly if
 * the generated file is missing (e.g. before a build). Keep in sync with
 * getProviderDisplayName() in src/core/model-registry.ts.
 */
let providerNamesCache = null;
async function loadProviderNames() {
	if (providerNamesCache) return providerNamesCache;
	const generated = path.join(fileURLToPath(new URL("../../..", import.meta.url)), "dist", "providers.json");
	try {
		providerNamesCache = JSON.parse(fs.readFileSync(generated, "utf8"));
		return providerNamesCache;
	} catch {
		// Pre-build dev fallback: derive from pi-ai directly.
		try {
			const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
			const map = {};
			for (const p of builtinProviders()) map[p.id] = p.name;
			providerNamesCache = map;
			return map;
		} catch {
			providerNamesCache = {};
			return providerNamesCache;
		}
	}
}

function authPath() {
	return path.join(os.homedir(), ".pizza", "agent", "auth.json");
}

function modelsPath() {
	return path.join(os.homedir(), ".pizza", "agent", "models.json");
}

function readAuth() {
	try {
		const raw = fs.readFileSync(authPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeAuth(data) {
	const dir = path.dirname(authPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(authPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function readModelsConfig() {
	try {
		const raw = fs.readFileSync(modelsPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeModelsConfig(data) {
	const dir = path.dirname(modelsPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(modelsPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function normalizeProviderId(value) {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) throw new Error("provider id required");
	if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
		throw new Error("provider id may only contain letters, numbers, dot, dash, and underscore");
	}
	return trimmed;
}

function normalizeBaseUrl(value) {
	const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(trimmed)) throw new Error("baseUrl must start with http:// or https://");
	if (/\s/.test(trimmed)) throw new Error("baseUrl cannot contain whitespace");
	return trimmed;
}

function apiForProtocol(protocol) {
	if (protocol === "openai") return "openai-completions";
	if (protocol === "anthropic") return "anthropic-messages";
	throw new Error(`unsupported protocol: ${protocol}`);
}

function firstCustomModelId(input) {
	const model = (input.models ?? [])
		.map((item) => String(item.id ?? "").trim())
		.find(Boolean);
	if (!model) throw new Error("at least one model id required");
	return model;
}

function joinApiPath(baseUrl, suffix) {
	const base = normalizeBaseUrl(baseUrl);
	if (base.endsWith("/v1") && suffix.startsWith("/v1/")) {
		return base + suffix.slice(3);
	}
	return base + suffix;
}

function shortenResponseText(value) {
	const text = String(value ?? "").trim();
	return text.length > 360 ? `${text.slice(0, 360)}...` : text;
}

function extractErrorText(value) {
	const error = value?.error;
	if (error?.message) return shortenResponseText(error.message);
	if (error?.type) return shortenResponseText(error.type);
	if (value?.message) return shortenResponseText(value.message);
	return null;
}

function extractAnthropicText(value) {
	const blocks = Array.isArray(value?.content) ? value.content : [];
	const block = blocks.find((item) => typeof item?.text === "string");
	return block ? shortenResponseText(block.text) : null;
}

function extractOpenAIText(value) {
	const content = value?.choices?.[0]?.message?.content;
	return typeof content === "string" ? shortenResponseText(content) : null;
}

async function testCustomProvider(input) {
	const protocol = input.protocol;
	apiForProtocol(protocol);
	const baseUrl = normalizeBaseUrl(input.base_url ?? input.baseUrl);
	const apiKey = String(input.api_key ?? input.apiKey ?? "").trim();
	if (!apiKey) throw new Error("apiKey required");
	const model = firstCustomModelId(input);
	const started = Date.now();

	const request =
		protocol === "anthropic"
			? {
				url: joinApiPath(baseUrl, "/v1/messages"),
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: {
					model,
					max_tokens: 1024,
					messages: [{ role: "user", content: "hi" }],
				},
			}
			: {
				url: joinApiPath(baseUrl, "/chat/completions"),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: {
					model,
					max_tokens: 1024,
					stream: false,
					messages: [{ role: "user", content: "hi" }],
				},
			};

	let response;
	try {
		response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: AbortSignal.timeout(60000),
		});
	} catch (error) {
		return {
			ok: false,
			protocol,
			model,
			message: `Failed to connect to API: ${error.message}`,
			response: null,
			status: null,
			duration_ms: Date.now() - started,
		};
	}

	const rawText = await response.text();
	let parsed = null;
	try {
		parsed = rawText ? JSON.parse(rawText) : null;
	} catch {}

	if (!response.ok) {
		const detail = extractErrorText(parsed) ?? shortenResponseText(rawText);
		return {
			ok: false,
			protocol,
			model,
			message: `API returned HTTP ${response.status}: ${detail}`,
			response: null,
			status: response.status,
			duration_ms: Date.now() - started,
		};
	}

	const text = protocol === "anthropic" ? extractAnthropicText(parsed) : extractOpenAIText(parsed);
	if (text) {
		return {
			ok: true,
			protocol,
			model,
			message: "Test completed successfully",
			response: text,
			status: response.status,
			duration_ms: Date.now() - started,
		};
	}
	return {
		ok: false,
		protocol,
		model,
		message: `API connected at ${request.url}, but the response format did not match the selected protocol.`,
		response: shortenResponseText(rawText),
		status: response.status,
		duration_ms: Date.now() - started,
	};
}

function protocolForApi(api) {
	if (api === "openai-completions" || api === "openai-responses") return "openai";
	if (api === "anthropic-messages") return "anthropic";
	return null;
}

function customProviderInfo(id, config, auth) {
	if (!config || typeof config !== "object") return null;
	const models = Array.isArray(config.models) ? config.models : [];
	if (models.length === 0) return null;
	const cred = auth[id];
	return {
		id,
		name: typeof config.name === "string" && config.name.trim() ? config.name : id,
		has_api_key: cred != null,
		auth_type: cred?.type ?? null,
		is_custom: true,
		protocol: protocolForApi(config.api),
		model_count: models.length,
	};
}

function saveCustomProvider(input) {
	const providerId = normalizeProviderId(input.id);
	const baseUrl = normalizeBaseUrl(input.base_url ?? input.baseUrl);
	const apiKey = String(input.api_key ?? input.apiKey ?? "").trim();
	if (!apiKey) throw new Error("apiKey required");
	const models = (input.models ?? [])
		.map((model) => ({
			id: String(model.id ?? "").trim(),
			name: String(model.name ?? model.id ?? "").trim(),
		}))
		.filter((model) => model.id);
	if (models.length === 0) throw new Error("at least one model id required");

	const modelsConfig = readModelsConfig();
	const providers = modelsConfig.providers && typeof modelsConfig.providers === "object" ? modelsConfig.providers : {};
	providers[providerId] = {
		name: String(input.name ?? providerId).trim() || providerId,
		baseUrl,
		api: apiForProtocol(input.protocol),
		models: models.map((model) => ({
			id: model.id,
			name: model.name || model.id,
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 16384,
		})),
	};
	modelsConfig.providers = providers;
	writeModelsConfig(modelsConfig);

	const auth = readAuth();
	auth[providerId] = { type: "api_key", key: apiKey };
	writeAuth(auth);
}

function removeCustomProvider(provider) {
	const providerId = normalizeProviderId(provider);
	const modelsConfig = readModelsConfig();
	const providers = modelsConfig.providers && typeof modelsConfig.providers === "object" ? modelsConfig.providers : {};
	delete providers[providerId];
	modelsConfig.providers = providers;
	writeModelsConfig(modelsConfig);

	const auth = readAuth();
	delete auth[providerId];
	writeAuth(auth);
}

async function listProviders() {
	const auth = readAuth();
	const names = await loadProviderNames();
	const modelProviders = readModelsConfig().providers ?? {};
	// Stable display order: built-in providers sorted by id, then custom ones.
	const builtinIds = Object.keys(names).sort();
	const providers = [];
	for (const id of builtinIds) {
		const cred = auth[id];
		providers.push({
			id,
			name: names[id] ?? id,
			has_api_key: cred != null,
			auth_type: cred?.type ?? null,
			is_custom: false,
			protocol: null,
			model_count: 0,
		});
	}
	for (const id of Object.keys(modelProviders).sort()) {
		if (names[id]) continue;
		const info = customProviderInfo(id, modelProviders[id], auth);
		if (info) providers.push(info);
	}
	for (const key of Object.keys(auth)) {
		if (!names[key] && !modelProviders[key]) {
			providers.push({
				id: key,
				name: key,
				has_api_key: true,
				auth_type: auth[key]?.type ?? null,
				is_custom: true,
				protocol: null,
				model_count: 0,
			});
		}
	}
	return providers;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (e) {
				reject(e);
			}
		});
	});
}

function sendJson(res, status, obj) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(obj));
}

/**
 * Vite dev plugin: spawns `pizza rpc` as a child process and exposes
 * HTTP endpoints for the browser to communicate with it.
 *
 *   POST /rpc/command   → send a JSON command to pizza stdin
 *   GET  /rpc/events    → SSE stream of stdout lines (responses + events)
 *   GET  /rpc/state     → convenience: sends get_state and returns the response
 *
 * In Tauri mode this plugin is not needed — the Rust bridge handles IPC.
 */
export function pizzaRpcBridge() {
	let child = null;
	let stdoutBuffer = [];
	const sseClients = new Set();

	function ensureChild() {
		if (child) return;
		// Prefer the local build (dist/src/cli.js) over the global `pizza` so
		// that dev:desktop uses the same code and node_modules as the build.
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const localCli = path.join(repoRoot, "dist", "src", "cli.js");
		const useLocal = fs.existsSync(localCli);
		const cmd = useLocal ? "node" : "pizza";
		const mainArgs = process.env.PIZZA_DEV_MAIN_DIR ? ["--main", "--main-dir", process.env.PIZZA_DEV_MAIN_DIR] : [];
		const args = useLocal ? [localCli, "--mode", "rpc", ...mainArgs] : ["--mode", "rpc", ...mainArgs];
		console.log(`[pizza-rpc-bridge] spawning ${cmd} ${args.join(" ")}...`);
		child = spawn(cmd, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: process.cwd(),
		});

		let lineBuf = "";
		child.stdout.on("data", (chunk) => {
			lineBuf += chunk.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop();
			for (const line of lines) {
				if (!line.trim()) continue;
				stdoutBuffer.push(line);
				for (const res of sseClients) {
					res.write(`data: ${line}\n\n`);
				}
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString().trim();
			if (text) console.error(`[pizza-rpc-bridge stderr] ${text}`);
		});

		child.on("error", (err) => {
			console.error(`[pizza-rpc-bridge] spawn error: ${err.message}`);
			child = null;
		});

		child.on("exit", (code, signal) => {
			console.log(`[pizza-rpc-bridge] child exited code=${code} signal=${signal}`);
			child = null;
		});
	}

	return {
		name: "pizza-rpc-bridge",
		configureServer(server) {
			ensureChild();

			server.middlewares.use("/rpc/init", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			// Send get_state and wait for the response
			const cmd = JSON.stringify({ type: "get_state", id: "init" }) + "\n";
			if (!child?.stdin?.writable) {
				res.statusCode = 503;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "pizza not running" }));
				return;
			}

			// Listen for the init response in the stdout buffer
			let resolved = false;
			const initTimer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				res.statusCode = 504;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "init timed out" }));
			}, 10000);

			// Check if response is already buffered
			for (const line of stdoutBuffer) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "response" && parsed.command === "get_state") {
						resolved = true;
						clearTimeout(initTimer);
						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(line);
						return;
					}
				} catch {}
			}

			// Not buffered yet — listen for it via a one-time SSE check
			const checkBuffer = setInterval(() => {
				for (const line of stdoutBuffer) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === "response" && parsed.command === "get_state" && !resolved) {
							resolved = true;
							clearTimeout(initTimer);
							clearInterval(checkBuffer);
							res.statusCode = 200;
							res.setHeader("Content-Type", "application/json");
							res.end(line);
							return;
						}
					} catch {}
				}
			}, 100);

			// Send the command
			child.stdin.write(cmd);
		});

		server.middlewares.use("/rpc/command", (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end("Method Not Allowed");
					return;
				}
				// Loopback/Origin guard (DNS-rebinding + cross-site POST): the
				// command channel drives an agent with shell access and, with the
				// browser panel, a visible browser — a remote page must not be
				// able to POST here. Requests without an Origin header (curl,
				// non-browser tools) are allowed; browsers always send Origin on
				// cross-origin POSTs.
				const origin = req.headers.origin;
				if (origin) {
					let allowed = false;
					try {
						const url = new URL(origin);
						const host = url.hostname;
						allowed =
							host === "127.0.0.1" || host === "localhost" || host === "::1" || host.endsWith(".localhost");
					} catch {}
					if (!allowed) {
						res.statusCode = 403;
						res.end(JSON.stringify({ error: "forbidden origin" }));
						return;
					}
				}
				let body = "";
				req.on("data", (chunk) => (body += chunk));
				req.on("end", () => {
					try {
						const cmd = JSON.parse(body);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify(cmd) + "\n");
							res.statusCode = 200;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ ok: true }));
						} else {
							res.statusCode = 503;
							res.end(JSON.stringify({ error: "pizza process not running" }));
						}
					} catch (e) {
						res.statusCode = 400;
						res.end(JSON.stringify({ error: e.message }));
					}
				});
			});

			server.middlewares.use("/rpc/providers", (req, res) => {
				if (req.method === "GET") {
					listProviders().then((p) => sendJson(res, 200, p)).catch((e) => sendJson(res, 500, { error: e.message }));
					return;
				}
				if (req.method === "POST") {
					readJsonBody(req).then((body) => {
						const { provider, apiKey, remove } = body;
						if (!provider) return sendJson(res, 400, { error: "provider required" });
						const auth = readAuth();
						if (remove) {
							delete auth[provider];
						} else {
							if (!apiKey) return sendJson(res, 400, { error: "apiKey required" });
							auth[provider] = { type: "api_key", key: apiKey };
						}
						writeAuth(auth);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify({ type: "reload_providers", id: `providers-${Date.now()}` }) + "\n");
						}
						sendJson(res, 200, { ok: true });
					}).catch((e) => sendJson(res, 400, { error: e.message }));
					return;
				}
				res.statusCode = 405;
				res.end("Method Not Allowed");
			});

			server.middlewares.use("/rpc/custom-provider", (req, res) => {
				if (req.method === "POST") {
					readJsonBody(req).then((body) => {
						saveCustomProvider(body);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify({ type: "reload_providers", id: `custom-provider-${Date.now()}` }) + "\n");
						}
						sendJson(res, 200, { ok: true });
					}).catch((e) => sendJson(res, 400, { error: e.message }));
					return;
				}
				if (req.method === "DELETE") {
					readJsonBody(req).then((body) => {
						if (!body.provider) return sendJson(res, 400, { error: "provider required" });
						removeCustomProvider(body.provider);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify({ type: "reload_providers", id: `custom-provider-${Date.now()}` }) + "\n");
						}
						sendJson(res, 200, { ok: true });
					}).catch((e) => sendJson(res, 400, { error: e.message }));
					return;
				}
				res.statusCode = 405;
				res.end("Method Not Allowed");
			});

			server.middlewares.use("/rpc/custom-provider/test", (req, res) => {
				if (req.method === "POST") {
					readJsonBody(req).then(async (body) => {
						const result = await testCustomProvider(body);
						sendJson(res, 200, result);
					}).catch((e) => sendJson(res, 400, { error: e.message }));
					return;
				}
				res.statusCode = 405;
				res.end("Method Not Allowed");
			});

			server.middlewares.use("/rpc/events", (req, res) => {
				if (req.method !== "GET") {
					res.statusCode = 405;
					res.end("Method Not Allowed");
					return;
				}
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				// Send buffered lines first
				for (const line of stdoutBuffer) {
					res.write(`data: ${line}\n\n`);
				}
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
			});
		},
	};
}
