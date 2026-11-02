/** Provider-specific authorization options cannot replace protocol or PKCE parameters. */
const RESERVED_PARAMS = new Set([
	"response_type", "client_id", "client_secret", "redirect_uri", "scope", "state", "resource",
	"code_challenge", "code_challenge_method", "request", "request_uri", "authorization_details",
]);

export function validateAuthorizationParams(value: unknown): string | undefined {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) return "oauth.authorizationParams must be an object of strings";
	for (const [key, entry] of Object.entries(value)) {
		if (!key || typeof entry !== "string") return "oauth.authorizationParams must be an object of strings";
		if (RESERVED_PARAMS.has(key.toLowerCase())) return `oauth.authorizationParams cannot override ${key}`;
	}
}
