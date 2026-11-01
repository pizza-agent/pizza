import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../../config.js";
import { PIZZA_GMAIL_DESKTOP_CLIENT_ID } from "./catalog.js";
/** Google requires this registration field even for public Desktop clients. It is not a confidential Web secret. */
export function packagedGoogleDesktopClientSecret(clientId: string | undefined): string | undefined {
	if (clientId !== PIZZA_GMAIL_DESKTOP_CLIENT_ID)
		return undefined;
	let value: {
		web?: unknown;
		installed?: {
			client_id?: unknown;
			client_secret?: unknown;
		};
	};
	try {
		value = JSON.parse(readFileSync(join(getPackageDir(), "assets", "google-desktop-oauth.json"), "utf8"));
	}
	catch {
		return undefined;
	}
	if (value.web || value.installed?.client_id !== clientId || typeof value.installed.client_secret !== "string")
		return undefined;
	return value.installed.client_secret || undefined;
}
