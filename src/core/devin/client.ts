/**
 * Minimal Connect-protocol (JSON codec) client for Cognition's Cascade API.
 *
 * The Devin model surface is served over Connect RPC at `server.codeium.com`
 * (`exa.api_server_pb` / `exa.seat_management_pb`). Unary calls are plain JSON
 * POSTs; server-streaming calls use the Connect envelope — a 5-byte header
 * (1 flag byte + 4-byte big-endian length) per message, with flag 0x02 marking
 * the terminal trailer frame that carries `{error}` on failure.
 *
 * Request identity matters: `ideName: "chisel"` unlocks the CLI model catalog
 * on `GetCliModelConfigs`, and `requestType: CASCADE` is required by
 * `GetChatMessage`.
 */

export interface ConnectError {
	code: string;
	message: string;
}

export class DevinApiError extends Error {
	readonly code: string;
	readonly httpStatus?: number;
	constructor(code: string, message: string, httpStatus?: number) {
		super(message);
		this.name = "DevinApiError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

const CLIENT_OS =
	process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const CLIENT_HARDWARE = process.arch === "arm64" ? "arm64" : "x86_64";

/** Identity used by released Devin CLI builds on inference/auth calls. */
export function devinChatMetadata(apiKey: string, extra?: { sessionId?: string; requestId?: string }) {
	return {
		apiKey,
		userJwt: "",
		ideName: "devin-cli",
		ideType: "chisel",
		ideVersion: "3000.11.3",
		extensionName: "chisel",
		extensionVersion: "3000.11.3",
		os: CLIENT_OS,
		hardware: CLIENT_HARDWARE,
		locale: "en",
		userAgent: "devin-cli/3000.11.3",
		...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
		...(extra?.requestId ? { requestId: extra.requestId } : {}),
	};
}

/** Identity used by the dev channel for `GetCliModelConfigs` (unlocks CLI catalog). */
export function devinDiscoveryMetadata(apiKey: string) {
	return {
		apiKey,
		ideName: "chisel",
		ideVersion: "3000.11.3",
		extensionName: "chisel",
		extensionVersion: "3000.11.3",
		os: CLIENT_OS,
		hardware: CLIENT_HARDWARE,
		locale: "en",
		userAgent: "devin-cli/3000.11.3",
	};
}

/** Encode one Connect envelope frame. */
export function encodeConnectFrame(payload: Uint8Array, flags = 0): Uint8Array {
	const out = new Uint8Array(5 + payload.byteLength);
	out[0] = flags;
	new DataView(out.buffer).setUint32(1, payload.byteLength, false);
	out.set(payload, 5);
	return out;
}

/** Incremental Connect envelope decoder for streaming responses. */
export class ConnectFrameDecoder {
	private buffer = new Uint8Array(0);

	/** Feed a chunk; returns all complete (flags, payload) frames available. */
	decode(chunk: Uint8Array): { flags: number; payload: Uint8Array }[] {
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.byteLength);
		this.buffer = merged;

		const frames: { flags: number; payload: Uint8Array }[] = [];
		let offset = 0;
		for (;;) {
			if (this.buffer.byteLength - offset < 5) break;
			const flags = this.buffer[offset];
			const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset + 1, 4).getUint32(0, false);
			if (this.buffer.byteLength - offset - 5 < length) break;
			frames.push({ flags, payload: this.buffer.subarray(offset + 5, offset + 5 + length) });
			offset += 5 + length;
		}
		this.buffer = this.buffer.subarray(offset);
		return frames;
	}
}

/** ProviderHeaders may carry nulls to suppress defaults; drop them. */
function activeHeaders(headers?: Record<string, string | null>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value !== null) out[key] = value;
	}
	return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Unary JSON Connect call. Throws DevinApiError on HTTP or Connect errors. */
export async function connectUnaryJson<T>(
	baseUrl: string,
	path: string,
	body: unknown,
	options?: { signal?: AbortSignal; fetch?: typeof fetch; headers?: Record<string, string | null> },
): Promise<T> {
	const fetchImpl = options?.fetch ?? fetch;
	const response = await fetchImpl(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"connect-protocol-version": "1",
			...activeHeaders(options?.headers),
		},
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	const text = await response.text();
	let parsed: { code?: string; message?: string } & Record<string, unknown> = {};
	try {
		parsed = JSON.parse(text);
	} catch {
		if (!response.ok) throw new DevinApiError("http_error", `HTTP ${response.status}`, response.status);
	}
	if (!response.ok) {
		throw new DevinApiError(parsed.code ?? "http_error", parsed.message ?? `HTTP ${response.status}`, response.status);
	}
	if (typeof parsed.code === "string" && parsed.code !== "ok" && parsed.message) {
		throw new DevinApiError(parsed.code, parsed.message, response.status);
	}
	return parsed as T;
}

export interface ConnectJsonStreamResult<TFrame> {
	frames: AsyncGenerator<TFrame, void, unknown>;
}

/**
 * Server-streaming Connect call with a JSON request message. Yields decoded
 * JSON frames; a trailer `{error}` frame rejects the iteration.
 */
export async function* connectStreamJson<TFrame = Record<string, unknown>>(
	baseUrl: string,
	path: string,
	body: unknown,
	options?: { signal?: AbortSignal; fetch?: typeof fetch; headers?: Record<string, string | null> },
): AsyncGenerator<TFrame, void, unknown> {
	const fetchImpl = options?.fetch ?? fetch;
	const requestPayload = encoder.encode(JSON.stringify(body));
	const response = await fetchImpl(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/connect+json",
			"connect-protocol-version": "1",
			...activeHeaders(options?.headers),
		},
		body: encodeConnectFrame(requestPayload),
		signal: options?.signal,
	});
	if (!response.ok) {
		const text = await response.text();
		let parsed: { code?: string; message?: string } = {};
		try {
			parsed = JSON.parse(text);
		} catch {
			// ignore
		}
		throw new DevinApiError(
			parsed.code ?? "http_error",
			parsed.message ?? `HTTP ${response.status}`,
			response.status,
		);
	}
	if (!response.body) throw new DevinApiError("empty_body", "Devin API returned an empty stream");

	const frameDecoder = new ConnectFrameDecoder();
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (value) {
			for (const { flags, payload } of frameDecoder.decode(value)) {
				const text = decoder.decode(payload).trim();
				if (flags & 0x02) {
					// Trailer frame: carries {"error":{code,message}} on failure.
					if (!text) continue;
					let trailer: { error?: ConnectError } = {};
					try {
						trailer = JSON.parse(text);
					} catch {
						continue;
					}
					if (trailer.error?.message) {
						throw new DevinApiError(trailer.error.code ?? "unknown", trailer.error.message);
					}
					continue;
				}
				if (!text) continue;
				yield JSON.parse(text) as TFrame;
			}
		}
		if (done) break;
	}
}

export const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const GET_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
