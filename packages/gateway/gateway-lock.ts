/**
 * Gateway ownership lock — one gateway per agent dir.
 *
 * Everything a gateway drives is global to the agent dir: the main agent
 * (`~/.pizza/main`, whose soul/memory/scheduler must have a single writer),
 * channel adapters (bot tokens), scheduled workspaces. Two gateways on
 * different sockets (e.g. the dev desktop's `gateway-dev.sock` next to the
 * installed app's `gateway.sock`) would each spawn a main agent — the loser
 * dies on the main lock — and fight over bots.
 *
 * The lock records the owner's socket, so instead of failing a client can
 * find the live gateway and attach to it (reuse), or shut it down to take
 * over. Lives at `<agentDir>/gateway.lock`.
 */

import { join } from "node:path";
import {
	acquirePidLock,
	isPidLockOwnerAlive,
	readPidLock,
	type MainAgentLock,
	type PidLockInfo,
} from "../../src/core/agent/main-agent.js";

export interface GatewayLockInfo extends PidLockInfo {
	socket: string;
	version?: string;
}

export function gatewayLockPath(agentDir: string): string {
	return join(agentDir, "gateway.lock");
}

/** The live gateway owning `agentDir`, or null (no lock, stale lock, or unreadable). */
export function readGatewayOwner(agentDir: string): GatewayLockInfo | null {
	const info = readPidLock(gatewayLockPath(agentDir));
	if (!info || typeof info.socket !== "string" || !isPidLockOwnerAlive(info)) return null;
	return info as GatewayLockInfo;
}

/**
 * Take the gateway lock for `agentDir`. A live owner on the SAME socket is
 * superseded: by the time we call this we already own the socket path (the
 * old owner was hung or displaced and exits via its ownership watchdog). So
 * is one on `unresponsiveSocket` — an owner the caller probed and found not
 * answering. Returns null when another live gateway owns the lock, or when
 * the lock cannot be written at all (callers treat that as best-effort).
 */
export function acquireGatewayLock(
	agentDir: string,
	socket: string,
	version: string,
	unresponsiveSocket?: string,
): MainAgentLock | null {
	return acquirePidLock(gatewayLockPath(agentDir), { socket, version }, {
		reclaimLive: (owner) => owner.socket === socket || (unresponsiveSocket !== undefined && owner.socket === unresponsiveSocket),
	});
}
