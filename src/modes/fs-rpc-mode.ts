/**
 * Hidden one-shot filesystem RPC mode for the desktop SSH bridge.
 *
 * The desktop starts this mode over SSH with the remote project as cwd. One
 * JSON request is read from stdin and one JSON response is written to stdout,
 * which avoids exposing a second network listener on the remote machine.
 */

import { writeSync } from "node:fs";
import { handleRemoteFsRequest, type RemoteFsRequest, type RemoteFsResponse } from "../core/remote/workspace-fs.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

async function readRequest(): Promise<RemoteFsRequest> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_REQUEST_BYTES) {
			throw new Error("Remote filesystem request is too large");
		}
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) {
		throw new Error("Remote filesystem request is empty");
	}
	return JSON.parse(raw) as RemoteFsRequest;
}

export async function runFsRpcMode(): Promise<never> {
	let request: RemoteFsRequest | undefined;
	let response: RemoteFsResponse;
	try {
		request = await readRequest();
		response = { id: request.id, ok: true, data: await handleRemoteFsRequest(request) };
	} catch (error) {
		response = {
			id: request?.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	// Use a synchronous FD write so a piped SSH stdout cannot truncate the
	// response when the short-lived process exits immediately afterwards.
	writeSync(1, `${JSON.stringify(response)}\n`);
	process.exit(response.ok ? 0 : 1);
}
