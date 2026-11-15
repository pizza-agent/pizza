// Exercise the compiled Worker with actual workerd + SQLite Durable Objects. Google responses are local fixtures.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pizza-google-worker-"));
let runtime;
try {
	const built = spawnSync(process.execPath, [join(cwd, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", temp], { cwd, encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	const issuer = "https://pizza.hertzbeat.com/oauth/google";
	const resource = "https://www.googleapis.com/drive/v3";
	const scope = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
	const target = "http://127.0.0.1:34567/callback";
	const verifier = "v".repeat(43);
	let upstream = 0, google;
	runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: await readFile(join(temp, "cloudflare.js"), "utf8"), compatibilityDate: "2026-11-14",
		durableObjects: { GOOGLE_SESSIONS: { className: "GoogleOAuthSession", useSQLite: true } },
		r2Buckets: ["PUBLIC_MEDIA"],
		ratelimits: { GOOGLE_RATE_LIMITER: { namespace_id: "497012345", simple: { limit: 60, period: 60 } } },
		bindings: { GOOGLE_CLIENT_ID: "runtime-fixture.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "runtime-fixture-secret", GOOGLE_TOKEN_KEY: "ab".repeat(32) },
		outboundService: async request => {
			assert.equal(request.url, "https://oauth2.googleapis.com/token");
			const p = new URLSearchParams(await request.text());
			assert.equal(p.get("client_id"), "runtime-fixture.apps.googleusercontent.com");
			assert.equal(p.get("client_secret"), "runtime-fixture-secret");
			assert.equal(p.get("resource"), null);
			if (p.get("grant_type") === "authorization_code") {
				assert.equal(createHash("sha256").update(p.get("code_verifier")).digest("base64url"), google.searchParams.get("code_challenge"));
				assert.equal(p.get("redirect_uri"), `${issuer}/callback`);
			} else assert.equal(p.get("refresh_token"), "runtime-private-refresh");
			upstream++;
			return Response.json({ access_token: `runtime-access-${upstream}`, refresh_token: "runtime-private-refresh", token_type: "Bearer", expires_in: 3600, scope });
		},
	}));
	// Real R2 bindings exercise video playback and seeking, independently of website builds.
	const media = await runtime.getR2Bucket("PUBLIC_MEDIA");
	await media.put("demos/runtime-video.mp4", "0123456789");
	const mediaUrl = "https://pizza.hertzbeat.com/media/demos/runtime-video.mp4";
	const full = await runtime.dispatchFetch(mediaUrl);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get("content-type"), "video/mp4");
	assert.equal(full.headers.get("content-length"), "10");
	assert.equal(await full.text(), "0123456789");
	const etag = full.headers.get("etag");
	for (const [range, status, body, contentRange] of [
		["bytes=2-5", 206, "2345", "bytes 2-5/10"],
		["bytes=7-", 206, "789", "bytes 7-9/10"],
		["bytes=-3", 206, "789", "bytes 7-9/10"],
		["bytes=0-99", 206, "0123456789", "bytes 0-9/10"],
		["bytes=10-", 416, "", "bytes */10"],
		["bytes=-0", 416, "", "bytes */10"],
		["bytes=5-2", 416, "", "bytes */10"],
		["bytes=0-1,5-6", 200, "0123456789", null],
	]) {
		const response = await runtime.dispatchFetch(mediaUrl, { headers: { Range: range } });
		assert.equal(response.status, status, range);
		assert.equal(response.headers.get("content-range"), contentRange, range);
		assert.equal(await response.text(), body, range);
	}
	const head = await runtime.dispatchFetch(mediaUrl, { method: "HEAD", headers: { Range: "bytes=2-5" } });
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("content-length"), "10");
	assert.equal(await head.text(), "");
	assert.equal((await runtime.dispatchFetch(mediaUrl, { headers: { "If-None-Match": etag } })).status, 304);
	assert.equal((await runtime.dispatchFetch(mediaUrl, { headers: { "If-Range": '"old"', Range: "bytes=2-5" } })).status, 200);
	assert.equal((await runtime.dispatchFetch(mediaUrl, { method: "PUT", body: "no uploads" })).status, 405);
	assert.equal((await runtime.dispatchFetch("https://pizza.hertzbeat.com/media/demos/missing.mp4")).status, 404);
	assert.equal((await runtime.dispatchFetch("https://pizza.hertzbeat.com/media/demos/private.json")).status, 404);
	console.log("Cloudflare R2 media passed: playback, HEAD, byte/suffix seeking, unsatisfiable ranges, conditional requests and read-only routing.");
	const fetch = (path, init = {}) => runtime.dispatchFetch(new URL(path, `${issuer}/`).href, { redirect: "manual", ...init });
	assert.equal((await fetch("health")).status, 200);
	assert.equal((await (await fetch("resources/drive")).json()).resource, resource);
	assert.equal((await runtime.dispatchFetch("https://pizza.hertzbeat.com/oauth/client.json")).status, 200);
	const start = await fetch(`authorize?${new URLSearchParams({ client_id: "pizza-desktop-google", response_type: "code", redirect_uri: target, resource, scope,
		state: "runtime-desktop-state-123456", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`);
	assert.equal(start.status, 302, await start.text());
	google = new URL(start.headers.get("location"));
	const done = await fetch(`callback?${new URLSearchParams({ state: google.searchParams.get("state"), code: "runtime-google-code" })}`,
		{ headers: { Cookie: start.headers.get("set-cookie").split(";")[0] } });
	assert.equal(done.status, 302, await done.text());
	const code = new URL(done.headers.get("location")).searchParams.get("code");
	const token = (params) => fetch("token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: "pizza-desktop-google", resource, ...params }).toString() });
	const request = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: target };
	const issued = await token(request);
	assert.equal(issued.status, 200, await issued.clone().text());
	const credentials = await issued.json();
	assert.equal(credentials.access_token, "runtime-access-1");
	assert.notEqual(credentials.refresh_token, "runtime-private-refresh");
	assert.equal((await token(request)).status, 400);
	const refresh = { grant_type: "refresh_token", refresh_token: credentials.refresh_token };
	const results = await Promise.all([token(refresh), token(refresh)]);
	assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
	assert.equal(upstream, 2);
	console.log("Cloudflare runtime passed: encrypted SQLite sessions, both PKCE legs, local callback, single-use code, refresh rotation and concurrent replay rejection. Google account authorization was simulated.");
} finally {
	await runtime?.dispose();
	await rm(temp, { recursive: true, force: true });
}
