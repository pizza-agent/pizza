import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import {
	deriveWorkspaceId,
	ensureWorkspaceMeta,
	getEventDatabasePath,
} from "../src/core/event-store/workspace.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import type { SessionListInfo } from "../src/core/session/session-listing.js";
import {
	DEFAULT_SESSION_LIMIT,
	collectSessions,
	formatRelativeTime,
	formatSessionsTable,
	parseSessionsArgs,
	sessionsToJson,
} from "../src/sessions-cli.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function seedWorkspace(): { cwd: string; agentDir: string; firstId: string; secondId: string } {
	const root = tempDir("pizza-sessions-");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const workspaceId = deriveWorkspaceId(cwd);
	ensureWorkspaceMeta(workspaceId, cwd, agentDir);
	const store = new SqliteEventStore(
		workspaceId,
		getEventDatabasePath(workspaceId, agentDir),
		"sessions_cli_test",
	);
	const manager = new SessionManager(store, store);

	const first = manager.getActiveSession();
	store.append({
		actor_id: "user",
		type: "USER_MESSAGE",
		payload: { content: "Fix the login bug\nplease" },
		thread_id: first.descriptor.thread_id,
	});
	manager.renameSession(first.descriptor.session_id, "Login bug");

	manager.createSession("user_explicit", "Second session");
	const second = manager.getActiveSession();
	store.append({
		actor_id: "user",
		type: "USER_MESSAGE",
		payload: { content: "Second task" },
		thread_id: second.descriptor.thread_id,
	});
	store.close();

	return {
		cwd,
		agentDir,
		firstId: first.descriptor.session_id,
		secondId: second.descriptor.session_id,
	};
}

function fixtureSession(overrides: Partial<SessionListInfo> = {}): SessionListInfo {
	return {
		path: "event-session:ws_test:sess_abcdef123456",
		id: "sess_abcdef123456",
		cwd: "/home/me/project",
		created: new Date("2026-01-01T00:00:00.000Z"),
		modified: new Date("2026-01-01T00:05:00.000Z"),
		messageCount: 3,
		firstMessage: "Fix the login bug\nplease",
		allMessagesText: "Fix the login bug please",
		...overrides,
	};
}

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-01-01T12:00:00.000Z");
	const ago = (seconds: number) => new Date(now - seconds * 1000);

	it("formats recent, hourly, daily, monthly, and yearly ages", () => {
		expect(formatRelativeTime(ago(30), now)).toBe("just now");
		expect(formatRelativeTime(ago(5 * 60), now)).toBe("5m ago");
		expect(formatRelativeTime(ago(3 * 3600), now)).toBe("3h ago");
		expect(formatRelativeTime(ago(2 * 86400), now)).toBe("2d ago");
		expect(formatRelativeTime(ago(45 * 86400), now)).toBe("1mo ago");
		expect(formatRelativeTime(ago(400 * 86400), now)).toBe("1y ago");
	});

	it("clamps future timestamps to 'just now'", () => {
		expect(formatRelativeTime(new Date(now + 60_000), now)).toBe("just now");
	});
});

describe("formatSessionsTable", () => {
	it("renders the short id, age, message count, and normalized title", () => {
		const table = formatSessionsTable([fixtureSession()], {
			now: Date.parse("2026-01-01T00:10:00.000Z"),
		});
		expect(table).toContain("ID");
		expect(table).toContain("UPDATED");
		expect(table).toContain("sess_abcdef1");
		expect(table).toContain("5m ago");
		expect(table).toContain("Fix the login bug please");
		expect(table).not.toContain("\nplease");
	});

	it("adds a project column for --all output", () => {
		const table = formatSessionsTable([fixtureSession()], { all: true });
		expect(table).toContain("PROJECT");
		expect(table).toContain("/home/me/project");
	});

	it("falls back to (untitled) when a session has no name or messages", () => {
		const table = formatSessionsTable([
			fixtureSession({ name: undefined, firstMessage: "" }),
		]);
		expect(table).toContain("(untitled)");
	});

	it("strips terminal control sequences from session titles", () => {
		const table = formatSessionsTable([
			fixtureSession({ firstMessage: "hello \u001b[31mred\u001b[0m" }),
		]);
		expect(table).toContain("hello red");
		expect(table).not.toContain("\u001b");
	});
});

describe("sessionsToJson", () => {
	it("emits a stable, secret-free JSON shape", () => {
		const json = sessionsToJson([fixtureSession()]);
		expect(json).toEqual([
			{
				id: "sess_abcdef123456",
				name: null,
				cwd: "/home/me/project",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:05:00.000Z",
				messageCount: 3,
				preview: "Fix the login bug\nplease",
				ref: "event-session:ws_test:sess_abcdef123456",
			},
		]);
	});

	it("does not leak the internal (no messages) placeholder", () => {
		const json = sessionsToJson([fixtureSession({ firstMessage: "(no messages)" })]);
		expect(json[0]!.preview).toBe("");
	});
});

describe("parseSessionsArgs", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = tempDir("pizza-sessions-cwd-");
	});

	it("defaults to the current workspace, newest 20, table output", () => {
		expect(parseSessionsArgs([], cwd)).toEqual({
			all: false,
			json: false,
			limit: DEFAULT_SESSION_LIMIT,
			cwd,
		});
	});

	it("parses all, json, and an unlimited row count", () => {
		expect(parseSessionsArgs(["--all", "--json", "--limit", "0"], cwd)).toMatchObject({
			all: true,
			json: true,
			limit: 0,
		});
	});

	it("resolves --cwd relative to the process workspace", () => {
		const child = join(cwd, "child");
		mkdirSync(child);
		expect(parseSessionsArgs(["--cwd", "child"], cwd).cwd).toBe(child);
	});

	it("rejects invalid limits", () => {
		expect(() => parseSessionsArgs(["--limit", "-1"], cwd)).toThrow(/non-negative integer/);
		expect(() => parseSessionsArgs(["--limit", "1.5"], cwd)).toThrow(/non-negative integer/);
		expect(() => parseSessionsArgs(["--limit", "nope"], cwd)).toThrow(/non-negative integer/);
	});

	it("rejects missing values, unknown flags, and conflicting selectors", () => {
		expect(() => parseSessionsArgs(["--limit"], cwd)).toThrow(/requires a value/);
		expect(() => parseSessionsArgs(["--cwd"], cwd)).toThrow(/requires a value/);
		expect(() => parseSessionsArgs(["--bogus"], cwd)).toThrow(/unknown option/);
		expect(() => parseSessionsArgs(["--all", "--cwd", cwd], cwd)).toThrow(/cannot be combined/);
	});

	it("rejects a workspace that does not exist or is a file", () => {
		expect(() => parseSessionsArgs(["--cwd", join(cwd, "missing")], cwd)).toThrow(/not found/);
		const file = join(cwd, "not-a-dir");
		writeFileSync(file, "not a directory");
		expect(() => parseSessionsArgs(["--cwd", file], cwd)).toThrow(/not a directory/);
	});
});

describe("collectSessions", () => {
	it("lists the current workspace's sessions with names and message counts", async () => {
		const { cwd, agentDir, firstId, secondId } = seedWorkspace();
		const sessions = await collectSessions(parseSessionsArgs([], cwd), agentDir);

		expect(sessions.map((session) => session.id)).toEqual(
			expect.arrayContaining([firstId, secondId]),
		);
		const named = sessions.find((session) => session.id === firstId);
		expect(named?.name).toBe("Login bug");
		expect(named?.cwd).toBe(cwd);
		expect(named?.messageCount).toBe(1);
		expect(named?.firstMessage).toContain("Fix the login bug");
	});

	it("returns an empty list for a workspace with no event database", async () => {
		const { agentDir } = seedWorkspace();
		const empty = parseSessionsArgs([], tempDir("pizza-sessions-empty-"));
		await expect(collectSessions(empty, agentDir)).resolves.toEqual([]);
	});
});
