import { basename, dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { getAgentDir } from "../src/config.js";
import {
	getAgentDirFromSessionDir,
	makeSessionRef,
	parseSessionRef,
	SESSION_REF_PREFIX,
} from "../src/core/session/session-ref.js";

describe("SESSION_REF_PREFIX", () => {
	test("is the documented event-session prefix", () => {
		expect(SESSION_REF_PREFIX).toBe("event-session:");
	});
});

describe("makeSessionRef", () => {
	test("joins workspace and session id with the prefix", () => {
		expect(makeSessionRef("ws", "sess_001")).toBe("event-session:ws:sess_001");
	});

	test("handles workspaces and ids with embedded slashes", () => {
		expect(makeSessionRef("acme/app", "sess_002")).toBe("event-session:acme/app:sess_002");
	});
});

describe("parseSessionRef", () => {
	test("round-trips a workspace + session ref produced by makeSessionRef", () => {
		const ref = makeSessionRef("ws", "sess_042");
		expect(parseSessionRef(ref)).toEqual({ workspaceId: "ws", sessionId: "sess_042" });
	});

	test("treats a bare ref without the prefix as a session id only", () => {
		expect(parseSessionRef("sess_123")).toEqual({ sessionId: "sess_123" });
	});

	test("does not set workspaceId when the prefix is absent", () => {
		const result = parseSessionRef("sess_123");
		expect(result.workspaceId).toBeUndefined();
	});

	test("rejects legacy .jsonl paths", () => {
		expect(() => parseSessionRef("events/sess_1.jsonl")).toThrow(/Legacy JSONL/);
	});

	test("rejects unix paths", () => {
		expect(() => parseSessionRef("some/nested/path")).toThrow(/Legacy JSONL/);
	});

	test("rejects windows paths", () => {
		expect(() => parseSessionRef("some\\nested\\path")).toThrow(/Legacy JSONL/);
	});

	test("throws on a prefixed ref with no session id", () => {
		expect(() => parseSessionRef("event-session:")).toThrow(/Invalid session reference/);
	});
});

describe("getAgentDirFromSessionDir", () => {
	test("returns the parent dir when the path ends in 'sessions'", () => {
		const agentDir = getAgentDirFromSessionDir("/home/me/.pizza/agent/sessions");
		expect(agentDir).toBe(dirname("/home/me/.pizza/agent/sessions"));
		expect(basename(agentDir)).toBe("agent");
	});

	test("returns the path itself when it does not end in 'sessions'", () => {
		const dir = "/home/me/.pizza/agent";
		expect(getAgentDirFromSessionDir(dir)).toBe(dir);
	});

	test("falls back to the default agent dir when no session dir is given", () => {
		// Thin glue over config.getAgentDir(); only assert it is a non-empty path.
		expect(typeof getAgentDirFromSessionDir(undefined)).toBe("string");
		expect(getAgentDirFromSessionDir(undefined).length).toBeGreaterThan(0);
		// Sanity: must agree with config.getAgentDir() directly.
		expect(getAgentDirFromSessionDir(undefined)).toBe(getAgentDir());
	});
});
