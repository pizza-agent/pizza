// Only intentionally published demo objects are exposed; the bucket has no public URL.
export async function mediaResponse(request, env) {
	if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	const path = new URL(request.url).pathname;
	if (!/^\/media\/demos\/[a-z0-9][a-z0-9._-]*\.(mp4|webp|gif)$/.test(path)) return new Response(null, { status: 404 });
	const key = path.slice("/media/".length);
	const object = await env?.PUBLIC_MEDIA?.head(key);
	if (!object) return new Response(null, { status: 404 });
	const headers = new Headers({
		"Content-Type": path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".webp") ? "image/webp" : "image/gif",
		"Cache-Control": "public, max-age=31536000, immutable",
		"Accept-Ranges": "bytes",
		"ETag": object.httpEtag,
		"X-Content-Type-Options": "nosniff",
	});
	const ifNoneMatch = request.headers.get("If-None-Match");
	if (ifNoneMatch?.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === object.httpEtag)) return new Response(null, { status: 304, headers });
	// A HEAD response describes the entire representation, regardless of Range.
	let range;
	const rangeHeader = request.headers.get("Range");
	const ifRange = request.headers.get("If-Range");
	if (request.method === "GET" && rangeHeader && (!ifRange || ifRange === object.httpEtag)) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
		// Unknown units, malformed and multipart ranges fall back to the full object.
		if (match && (match[1] || match[2])) {
			const start = match[1] ? Number(match[1]) : Math.max(0, object.size - Number(match[2]));
			const end = match[1] && match[2] ? Math.min(Number(match[2]), object.size - 1) : object.size - 1;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= object.size) {
				headers.set("Content-Range", `bytes */${object.size}`);
				return new Response(null, { status: 416, headers });
			}
			range = { offset: start, length: end - start + 1 };
			headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
		}
	}
	headers.set("Content-Length", String(range?.length ?? object.size));
	if (request.method === "HEAD") return new Response(null, { headers });
	const body = await env.PUBLIC_MEDIA.get(key, { ...(range ? { range } : {}), onlyIf: { etagMatches: object.etag } });
	if (!body || !("body" in body)) return new Response(null, { status: 404 });
	return new Response(body.body, { status: range ? 206 : 200, headers });
}
