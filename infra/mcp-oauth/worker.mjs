import { metadataResponse } from "./metadata.mjs";
import { googleBrokerResponse } from "./google-broker.mjs";
export { GoogleOAuthSession } from "./google-broker.mjs";

export default {
	fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path.startsWith("/oauth/google/")) return googleBrokerResponse(request, env);
		// Reserve every OAuth path before website assets, including unknown paths.
		if (path === "/oauth" || path.startsWith("/oauth/")) return metadataResponse(request);
		if (env?.ASSETS) {
			if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
			return env.ASSETS.fetch(request);
		}
		return metadataResponse(request);
	},
};
