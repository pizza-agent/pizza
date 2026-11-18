import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	playCapsule,
	recordAct,
	recordingName,
	startRecording,
	stopRecording,
	listCapsules,
	deleteCapsule,
} from "../src/builtin-extensions/computer-use/capsules";
import { capsuleCommand } from "../src/builtin-extensions/desktop-capsules/index";
import type { ExtensionContext } from "../src/core/extensions/types";
import type { ActParams } from "../src/builtin-extensions/computer-use/backend/contract";

function fakeCtx(): ExtensionContext {
	return {
		cwd: "/workspace",
		sessionManager: {
			projection: {
				getDescriptor: () => ({
					session_id: "session-a",
					thread_id: "thread-a",
					workspace_id: "ws",
					event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
					created_by: "user_explicit",
					created_at: 0,
				}),
			},
		},
	} as unknown as ExtensionContext;
}

describe("desktop capsules", () => {
	let dir: string;
	let previous: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-capsules-"));
		previous = process.env.PIZZA_AGENT_DIR;
		process.env.PIZZA_AGENT_DIR = dir;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.PIZZA_AGENT_DIR;
		else process.env.PIZZA_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	it("records refs as selectors and replays them against fresh refs", async () => {
		const ctx = fakeCtx();
		startRecording(ctx, "approve");
		await recordAct(
			ctx,
			{
				stateId: "state-1",
				actions: [{ action: "click", ref: "@e1" }],
				expect: { ref: "@e2", text: "Approved" },
			} as ActParams,
			{
				inspect: async () => ({
					content: [],
					details: { target: { role: "button", title: "Approve", identifier: "approve", description: "" } },
				}),
				search: async () => ({ content: [], details: { matches: [] } }),
				act: async () => ({ content: [], details: {} }),
			} as never,
		);
		expect(recordingName(ctx)).toBe("approve");
		const capsule = await stopRecording(ctx);
		expect(capsule.steps[0].actions[0].selector).toMatchObject({ role: "button", title: "Approve" });
		expect(capsule.steps[0].expect?.selector).toMatchObject({ role: "button", title: "Approve" });
		expect((await listCapsules()).map((item) => item.name)).toContain("approve");

		let actParams: Record<string, unknown> | undefined;
		const played = await playCapsule(ctx, "approve", "state-1", {
			search: async () => ({
				content: [],
				details: {
					matches: [{ ref: "@e9", role: "button", label: "Approve", path: "root/Approve" }],
				},
			}),
			act: async (_id: string, params: Record<string, unknown>) => {
				actParams = params;
				return { content: [], details: { capture: { stateId: "state-2" } } };
			},
			inspect: async () => ({ content: [], details: {} }),
		} as never);
		expect(played.finalStateId).toBe("state-2");
		expect((actParams?.actions as Array<{ ref?: string }>)[0]?.ref).toBe("@e9");
		expect(actParams?.expect).toMatchObject({ ref: "@e9", text: "Approved" });
	});

	it("parses capsule commands", () => {
		expect(capsuleCommand.parseArguments?.(["record", "my-flow"], undefined, {})).toMatchObject({
			subcommand: "record",
			name: "my-flow",
		});
		expect(capsuleCommand.parseArguments?.(["play", "my-flow", "--state", "s1"], undefined, {})).toMatchObject({
			subcommand: "play",
			name: "my-flow",
			stateId: "s1",
		});
		expect(() => capsuleCommand.parseArguments?.(["play", "my-flow"], undefined, {})).toThrow(/--state/);
		expect(() => capsuleCommand.parseArguments?.(["record"], undefined, {})).toThrow(/name/);
	});

	it("deletes a saved capsule", async () => {
		const ctx = fakeCtx();
		startRecording(ctx, "delete-me");
		await recordAct(ctx, { stateId: "s", actions: [{ action: "click" }] } as ActParams, {
			inspect: async () => ({ content: [], details: {} }),
			search: async () => ({ content: [], details: {} }),
			act: async () => ({ content: [], details: {} }),
		} as never);
		await stopRecording(ctx);
		await deleteCapsule("delete-me");
		expect((await listCapsules()).some((item) => item.name === "delete-me")).toBe(false);
	});
});
