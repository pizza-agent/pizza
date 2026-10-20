/**
 * Navigation policy for the managed browser.
 *
 * Enforced per navigation (including redirects and JS-driven navigation —
 * see the controller's framenavigated hook), not just on `_browser open`:
 * a domain allowlist that only checks the entry URL is trivially bypassed
 * by a 30x or `location.href`.
 *
 * Rules:
 *  - scheme allowlist: http/https only. file:, chrome:, devtools:, about:,
 *    data:, view-source:, javascript: are blocked outright.
 *  - loopback origins (127.0.0.0/8, ::1, *.localhost) are allowed — testing
 *    local dev servers is a primary use case (same posture as ZCode's
 *    control-browser skill).
 *  - other private ranges (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7,
 *    fe80::/10, 0.0.0.0) are "ask" under the "on" approval policy and allowed
 *    (with an audit event) under "auto".
 *  - new public origins: allowed under "auto" (audited), "ask" under "on".
 *
 * "ask" without a resolver fails closed (deny).
 */

import type { PolicyDecision } from "./types.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function isIPv4Literal(hostname: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function ipv4ToLong(hostname: string): number {
	const parts = hostname.split(".").map((p) => Number.parseInt(p, 10));
	return ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
}

function inCidr4(ip: number, network: number, bits: number): boolean {
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (ip & mask) >>> 0 === (network & mask) >>> 0;
}

const PRIVATE_V4_RANGES: Array<[network: number, bits: number, name: string]> = [
	[0x7f000000, 8, "loopback"], // 127.0.0.0/8
	[0x0a000000, 8, "private"], // 10.0.0.0/8
	[0xac100000, 12, "private"], // 172.16.0.0/12
	[0xc0a80000, 16, "private"], // 192.168.0.0/16
	[0xa9fe0000, 16, "link-local"], // 169.254.0.0/16
];

export type AddressClass = "public" | "loopback" | "private" | "link-local" | "invalid";

/** Classify a URL's host address class (hostname already lowercased). */
export function classifyAddress(hostname: string): AddressClass {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
	if (host === "0.0.0.0" || host === "[::]" || host === "::") return "invalid";
	if (isIPv4Literal(host)) {
		const ip = ipv4ToLong(host);
		for (const [network, bits, name] of PRIVATE_V4_RANGES) {
			if (inCidr4(ip, network, bits)) return name as AddressClass;
		}
		return "public";
	}
	if (host.includes(":")) {
		// IPv6 literal
		if (host === "::1") return "loopback";
		if (host.startsWith("fc") || host.startsWith("fd")) return "private"; // fc00::/7
		if (host.startsWith("fe80")) return "link-local";
		return "public";
	}
	return "public";
}

/** Parse and normalize a URL; returns null for unparseable input. */
export function normalizeUrl(raw: string): URL | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		return new URL(withScheme);
	} catch {
		return null;
	}
}

export type ApprovalMode = "auto" | "on" | "off";

export interface NavigationPolicyOptions {
	/** "on" asks for new/non-public origins; "auto"/"off" allow with audit. */
	approvalMode?: ApprovalMode;
	/**
	 * Resolve "ask" decisions. Return true to allow (origin is then added to
	 * the session allowlist), false to deny. Absent => deny (fail closed).
	 */
	resolveApproval?: (url: string, reason: string) => Promise<boolean>;
	/** Extra origins treated as pre-approved (e.g. from settings). */
	allowedOrigins?: string[];
}

export class NavigationPolicy {
	private readonly sessionAllowlist = new Set<string>();
	private approvalMode: ApprovalMode;
	private readonly resolveApproval?: (url: string, reason: string) => Promise<boolean>;

	constructor(options: NavigationPolicyOptions = {}) {
		this.approvalMode = options.approvalMode ?? "auto";
		this.resolveApproval = options.resolveApproval;
		for (const origin of options.allowedOrigins ?? []) this.sessionAllowlist.add(origin);
	}

	setApprovalMode(mode: ApprovalMode): void {
		this.approvalMode = mode;
	}

	getMode(): ApprovalMode {
		return this.approvalMode;
	}

	/** Origins approved this session (audit/UI). */
	allowedOrigins(): string[] {
		return [...this.sessionAllowlist];
	}

	/** Forget all per-session approvals (emergency stop / reset). */
	reset(): void {
		this.sessionAllowlist.clear();
	}

	/**
	 * Static classification — no side effects, no prompts. Used for the
	 * frameNavigated hook where we cannot await an approval dialog without
	 * wedging the page.
	 */
	classify(rawUrl: string): PolicyDecision {
		const url = normalizeUrl(rawUrl);
		if (!url) return { decision: "block", origin: "", reason: "invalid_url" };
		const origin = url.origin;
		if (!ALLOWED_SCHEMES.has(url.protocol)) {
			return { decision: "block", origin, reason: `scheme_not_allowed:${url.protocol.replace(":", "")}` };
		}
		const addressClass = classifyAddress(url.hostname);
		if (addressClass === "invalid") {
			return { decision: "block", origin, reason: "invalid_address" };
		}
		if (this.sessionAllowlist.has(origin)) {
			return { decision: "allow", origin };
		}
		if (addressClass === "loopback") {
			// Local dev servers are a primary use case; allow but audited.
			this.sessionAllowlist.add(origin);
			return { decision: "allow", origin, reason: "loopback_auto_allowed" };
		}
		if (addressClass === "public") {
			return this.getMode() === "on"
				? { decision: "ask", origin, reason: "new_origin" }
				: { decision: "allow", origin, reason: this.getMode() === "auto" ? "auto_allowed" : undefined };
		}
		// private / link-local
		return this.getMode() === "on"
			? { decision: "ask", origin, reason: `non_public_origin:${addressClass}` }
			: { decision: "allow", origin, reason: `non_public_origin_auto:${addressClass}` };
	}

	/**
	 * Full check with prompts: resolves "ask" through the approval hook and
	 * remembers approvals for the session. Used by `_browser open` /
	 * `browser_navigate` where awaiting a decision is fine.
	 */
	async check(rawUrl: string, source: string): Promise<PolicyDecision & { decidedBy: string }> {
		const first = this.classify(rawUrl);
		if (first.decision !== "ask") {
			return { ...first, decidedBy: first.decision === "allow" && first.reason ? first.reason : "policy" };
		}
		if (!this.resolveApproval) {
			return { ...first, decision: "block", reason: `${first.reason ?? "ask"}:no_resolver`, decidedBy: "fail_closed" };
		}
		let allowed = false;
		try {
			allowed = await this.resolveApproval(rawUrl, first.reason ?? "ask");
		} catch {
			allowed = false;
		}
		if (allowed) {
			this.sessionAllowlist.add(first.origin);
			return { ...first, decision: "allow", reason: "user_approved", decidedBy: source };
		}
		return { ...first, decision: "block", reason: `${first.reason ?? "ask"}:denied`, decidedBy: source };
	}
}
