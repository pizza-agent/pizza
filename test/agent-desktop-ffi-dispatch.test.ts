import { describe, expect, it } from "vitest";
import { dispatchViaFfi } from "../src/builtin-extensions/agent-desktop/ffi-dispatch.js";
import type { FfiAdapter, FfiSnapshotOptions } from "../src/builtin-extensions/agent-desktop/ffi.js";

function fakeFfi(calls: string[] = []): FfiAdapter {
	return {
		available: true,
		checkPermissions: () => 0,
		status: () => {
			calls.push("status");
			return JSON.stringify({ ok: true, command: "status", data: {} });
		},
		snapshot: (options: FfiSnapshotOptions, sessionId?: string) => {
			calls.push(`snapshot:${options.app ?? "none"}:${options.maxDepth}:${options.compact}:${sessionId ?? "nosession"}`);
			return JSON.stringify({ ok: true, command: "snapshot", data: { ref_count: 3 } });
		},
		executeRef: (ref: string, action: ArrayBuffer, sessionId?: string) => {
			calls.push(`execute:${ref}:${new DataView(action).getInt32(0, true)}:${sessionId ?? "nosession"}`);
			return JSON.stringify({ ok: true, command: "execute_by_ref" });
		},
		version: () => JSON.stringify({ ok: true, command: "version", data: { version: "1.3.1" } }),
		clipboardGet: () => "",
		clipboardSet: () => 0,
		closeApp: (id: string, force: boolean) => {
			calls.push(`close-app:${id}:${force}`);
			return id === "bad" ? -3 : 0;
		},
		listApps: () => {
			calls.push("list-apps");
			return [{ name: "Finder", pid: 1, bundleId: "com.apple.finder" }];
		},
	};
}

describe("dispatchViaFfi", () => {
	it("passes status through", () => {
		const result = dispatchViaFfi(fakeFfi(), ["status"]);
		expect(result?.code).toBe(0);
		expect(JSON.parse(result!.stdout).command).toBe("status");
	});

	it("maps snapshot flags and session", () => {
		const calls: string[] = [];
		const result = dispatchViaFfi(fakeFfi(calls), ["snapshot", "--app", "Finder", "--compact", "-i", "--session", "s1"]);
		expect(result?.code).toBe(0);
		expect(calls[0]).toBe("snapshot:Finder:10:true:s1");
	});

	it("falls back for --root snapshots", () => {
		expect(dispatchViaFfi(fakeFfi(), ["snapshot", "--root", "@s1:e2"])).toBeNull();
	});

	it("executes click kind 0 by ref", () => {
		const calls: string[] = [];
		dispatchViaFfi(fakeFfi(calls), ["click", "@s1:e2", "--session", "s1"]);
		expect(calls[0]).toBe("execute:@s1:e2:0:s1");
	});

	it("sends type text via stdin secret", () => {
		const calls: string[] = [];
		const ffi = fakeFfi(calls);
		const result = dispatchViaFfi(ffi, ["type", "@s1:e2", "--stdin"], "hunter2");
		expect(result?.code).toBe(0);
		expect(calls[0]).toContain("execute:@s1:e2:17:");
	});

	it("maps scroll direction and amount", () => {
		const calls: string[] = [];
		dispatchViaFfi(fakeFfi(calls), ["scroll", "@s1:e1", "--direction", "down", "--amount", "3"]);
		expect(calls[0]).toBe("execute:@s1:e1:12:nosession");
	});

	it("returns null for commands outside the FFI subset", () => {
		for (const argv of [
			["find", "--app", "Notes", "--role", "button"],
			["get", "@s1:e1", "--property", "value"],
			["list-windows"],
			["permissions"],
			["clipboard-get"],
			["clipboard-set", "x"],
			["screenshot"],
			["press", "tab"],
			["session", "start"],
		]) {
			expect(dispatchViaFfi(fakeFfi(), argv), argv.join(" ")).toBeNull();
		}
	});

	it("synthesizes list-apps envelope with CLI field names", () => {
		const result = dispatchViaFfi(fakeFfi(), ["list-apps"]);
		const env = JSON.parse(result!.stdout);
		expect(env.command).toBe("list-apps");
		expect(env.data.apps[0]).toMatchObject({ name: "Finder", pid: 1, bundle_id: "com.apple.finder" });
	});

	it("maps close-app results and error codes", () => {
		const okResult = dispatchViaFfi(fakeFfi(), ["close-app", "com.apple.notes"]);
		expect(JSON.parse(okResult!.stdout).ok).toBe(true);
		const badResult = dispatchViaFfi(fakeFfi(), ["close-app", "bad"]);
		expect(JSON.parse(badResult!.stdout).error.code).toBe("APP_NOT_FOUND");
	});

	it("returns a structured error when the FFI call throws", () => {
		const ffi = fakeFfi();
		ffi.status = () => {
			throw new Error("boom");
		};
		const result = dispatchViaFfi(ffi, ["status"]);
		expect(result?.code).toBe(1);
		expect(JSON.parse(result!.stdout).error.code).toBe("INTERNAL");
	});
});
