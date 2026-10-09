/**
 * Example: embedding the Pizza SDK in a Node server.
 *
 * Uses Node's built-in http module to wrap the Pizza agent in a
 * POST /ask endpoint. Request body: { "prompt": "..." }
 * Response body: { "text": "...", "events": [...] }
 *
 * Usage:
 *   1. Build Pizza:     npm run build
 *   2. Set an API key:  export ANTHROPIC_API_KEY=sk-...
 *   3. Run:             node examples/sdk-server.mjs
 *   4. Test:            curl -s localhost:3001/ask -d '{"prompt":"hi"}' -H 'Content-Type: application/json'
 *
 * One facade is reused across requests — Pizza manages context/compaction/
 * branching automatically. For a fresh session per request, move
 * createFacade() inside handleAsk instead.
 */

import { createServer } from "node:http";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  createSessionFacade,
} from "../dist/src/index.js";

const PORT = Number(process.env.PORT ?? 3001);
const CWD = process.cwd();
const AGENT_DIR = process.env.PIZZA_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pizza", "agent");

// ---------- 1. Build services (auth / model / settings / resource loader) ----------
const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
const settingsManager = SettingsManager.create(CWD, AGENT_DIR);
const modelRegistry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
const resourceLoader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: AGENT_DIR,
  settingsManager,
});
await resourceLoader.reload();

// ---------- 2. Create the facade (event-sourced session) ----------
const { facade, model } = await createSessionFacade({
  cwd: CWD,
  agentDir: AGENT_DIR,
  authStorage,
  settingsManager,
  modelRegistry,
  resourceLoader,
  // storagePath left unset -> defaults to SQLite persistence at ~/.pizza/agent
  // storagePath: ":memory:",  // in-memory store for tests
});

if (!model) {
  console.error("No model available — set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY etc.");
  process.exit(1);
}
console.log(`[pizza-sdk] facade ready, model=${model.provider}/${model.id}`);

// ---------- 3. HTTP server ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleAsk(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "invalid json body" });
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) return sendJson(res, 400, { error: "missing 'prompt'" });

  // Collect this turn's events (optional — for real-time rendering on the frontend)
  const events = [];
  const unsub = facade.subscribe((event) => events.push(event));

  try {
    await facade.prompt(prompt);
    const messages = facade.getProjection().buildContext().messages;
    const last = messages[messages.length - 1];
    const text =
      last?.role === "assistant"
        ? Array.isArray(last.content)
          ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : String(last.content ?? "")
        : "";
    return sendJson(res, 200, { text, events });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    unsub();
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/ask") return handleAsk(req, res);
  if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true, model: model.id });
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[pizza-sdk] listening on http://localhost:${PORT}`);
  console.log(`[pizza-sdk] try: curl -s localhost:${PORT}/ask -d '{"prompt":"hi"}' -H 'Content-Type: application/json'`);
});

// ---------- 4. Graceful shutdown ----------
async function shutdown() {
  console.log("\n[pizza-sdk] shutting down...");
  server.close();
  await facade.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
