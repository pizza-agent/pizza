import template from "./client.json" with { type: "json" };

export const defaultMetadataUrl = template.client_id;

export function metadataBase(baseUrl = defaultMetadataUrl) {
	const base = new URL(baseUrl);
	if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/client.json")) {
		throw new Error("Metadata URL must be HTTPS and end in /client.json without credentials, query or fragment");
	}
	return base;
}

/** Shared Web API handler for Cloudflare Workers and the optional local Node server. */
export function metadataResponse(request, baseUrl = defaultMetadataUrl) {
	const base = metadataBase(baseUrl);
	const url = new URL(request.url);
	const prefix = base.pathname.slice(0, -"client.json".length);
	const suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
	const match = /^([A-Za-z0-9_-]{12})\/client\.json$/.exec(suffix);
	if (url.search || (url.pathname !== base.pathname && !match)) return new Response(null, { status: 404 });
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	}
	const id = match?.[1];
	const path = `/callback${id ? `/${id}` : ""}`;
	const document = {
		...template,
		client_id: `${base.origin}${url.pathname}`,
		redirect_uris: [`http://127.0.0.1${path}`, `http://localhost${path}`],
	};
	return new Response(request.method === "HEAD" ? null : JSON.stringify(document), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
