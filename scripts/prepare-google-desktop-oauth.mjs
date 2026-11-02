/** Package only a Google installed/desktop client registration, never a Web client. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../dist/assets/google-desktop-oauth.json", import.meta.url));
const input = process.env.PIZZA_GOOGLE_DESKTOP_CLIENT_FILE;
const registration = process.env.PIZZA_GOOGLE_DESKTOP_CLIENT_JSON;
if (!input && !registration) {
	rmSync(output, { force: true });
	if (process.env.PIZZA_REQUIRE_GOOGLE_DESKTOP_CLIENT === "1")
		throw Error("Release requires the Google Desktop client registration");
	console.log(
		"[google-desktop-oauth] No desktop registration supplied; release Gmail sign-in requires PIZZA_GOOGLE_DESKTOP_CLIENT_FILE.",
	);
} else {
	let value;
	try {
		value = JSON.parse(input ? readFileSync(input, "utf8") : registration);
	} catch {
		throw Error("Invalid Google Desktop registration JSON");
	}
	const installed = value.installed;
	if (
		value.web ||
		!installed ||
		installed.client_id !== "509874026147-a4b12qhk6rsqma5vqo96qk8b5f7vgr51.apps.googleusercontent.com" ||
		typeof installed.client_secret !== "string" ||
		!installed.client_secret
	)
		throw Error("Expected the Pizza Google Desktop client JSON, not a Web client or a different app.");
	mkdirSync(new URL("../dist/assets/", import.meta.url), { recursive: true });
	writeFileSync(
		output,
		JSON.stringify({ installed: { client_id: installed.client_id, client_secret: installed.client_secret } }),
		{ mode: 0o600 },
	);
	console.log("[google-desktop-oauth] Packaged the public Desktop client registration; PKCE remains required.");
}
