// Import a publisher-owned Google Web client straight into Cloudflare secrets, without printing credentials.
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const wrangler = fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url));
function run(args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [wrangler, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", chunk => { output += chunk; });
		// Wrangler diagnostics are deliberately not forwarded when sending secret material.
		child.stderr.resume();
		child.stdin.on("error", () => {});
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve(output) : reject(new Error("Cloudflare configuration failed. Check Wrangler login and retry; credentials were not printed.")));
		child.stdin.end(input);
	});
}
try {
	if (!process.argv[2]) throw new Error("Usage: node infra/mcp-oauth/configure-google.mjs /absolute/path/to/google-web-client.json");
	const downloaded = JSON.parse(await readFile(process.argv[2], "utf8"));
	const web = downloaded.web;
	if (typeof web?.client_id !== "string" || !web.client_id.endsWith(".apps.googleusercontent.com") || typeof web.client_secret !== "string" || !web.client_secret) {
		throw new Error("Use the downloaded Google Web OAuth client JSON, containing its client ID and secret.");
	}
	// Older downloads keep their original callback list even after a Google Console edit.
	if (!web.redirect_uris?.includes("https://pizza.hertzbeat.com/oauth/google/callback")) console.log("This JSON predates the broker callback. Verify https://pizza.hertzbeat.com/oauth/google/callback is saved in Google Console before signing in.");
	const secrets = JSON.parse(await run(["secret", "list"]));
	const values = { GOOGLE_CLIENT_ID: web.client_id, GOOGLE_CLIENT_SECRET: web.client_secret };
	if (!secrets.some(secret => secret.name === "GOOGLE_TOKEN_KEY")) values.GOOGLE_TOKEN_KEY = randomBytes(32).toString("hex");
	await run(["secret", "bulk"], JSON.stringify(values));
	console.log("Google publisher registration saved in Cloudflare. Credentials were not written to the repository or printed. Verify /oauth/google/health, then complete a real account sign-in.");
} catch (error) {
	// Do not forward JSON parser errors, which may quote secret input.
	console.error(error instanceof SyntaxError ? "Invalid client JSON or Cloudflare response. No credentials printed." : error.message);
	process.exitCode = 1;
}
