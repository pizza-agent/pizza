import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));
// This is the Node entry script used before Vite starts.
import { freePort, isRepoDevProcess } from "../apps/web/scripts/free-port.mjs";

const webDir = fileURLToPath(new URL("../apps/web", import.meta.url));

describe("dev listener ownership", () => {
	it.each([
		[{ cmd: "node /other/project/node_modules/.bin/vite", cwd: "/other/project" }, false],
		[{ cmd: "bun run dev apps/web", cwd: "/other/project" }, false],
		[{ cmd: `node ${webDir}-other/node_modules/.bin/vite` }, false],
		[{ cmd: "vite", cwd: webDir }, true],
		[{ cmd: `node '${webDir}/node_modules/.bin/vite'` }, true],
		[{ cmd: "node server.js", cwd: webDir }, false],
		[{ cmd: `node "${webDir}/server.js"`, cwd: webDir }, false],
		[{ cmd: "vite" }, false],
		[{ cmd: `node ${webDir}/node_modules/.bin/vite`, cwd: "/other/project" }, false],
	])("classifies %j as owned=%s", (listener, owned) => {
		expect(isRepoDevProcess(listener, webDir)).toBe(owned);
	});

	it("matches quoted Windows paths case-insensitively with directory boundaries", () => {
		expect(isRepoDevProcess({ cmd: 'node "C:\\My Repo\\apps\\web\\node_modules\\vite\\bin\\vite.js"' }, 'c:\\my repo\\apps\\web', "win32")).toBe(true);
		expect(isRepoDevProcess({ cmd: 'node "C:\\My Repo\\apps\\web-other\\vite.js"' }, 'c:\\my repo\\apps\\web', "win32")).toBe(false);
	});
});

describe("free-port startup", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	beforeEach(() => {
		// Exercise Unix inspection with mocked commands on every CI host.
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		execFileSync.mockReset();
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function mockListener(cmd: string, cwd: string, linger = false) {
		let polls = 0;
		execFileSync.mockImplementation((file: string, args: string[]) => {
			if (file === "ps") return cmd;
			if (args.includes("cwd")) return `p12345\nn${cwd}\n`;
			if (file === "lsof") return polls++ === 0 || linger ? "12345\n" : "";
			throw new Error(`Unexpected command ${file}`);
		});
	}

	it("refuses an unrelated Vite listener without sending a signal", async () => {
		mockListener("node /other/node_modules/.bin/vite", "/other");
		await expect(freePort()).rejects.toThrow("refusing to kill");
		expect(process.kill).not.toHaveBeenCalled();
	});

	it("terminates an owned listener and checks that the port is released", async () => {
		mockListener("node node_modules/.bin/vite", webDir);
		await freePort();
		expect(process.kill).toHaveBeenCalledWith(12345);
		expect(execFileSync.mock.calls.filter(([file, args]) => file === "lsof" && !args.includes("cwd"))).toHaveLength(2);
	});

	it("fails instead of starting Vite while a listener ignores SIGTERM", async () => {
		vi.useFakeTimers();
		mockListener("vite", webDir, true);
		const result = expect(freePort()).rejects.toThrow("still occupied");
		await vi.advanceTimersByTimeAsync(2100);
		await result;
	});

	it("surfaces missing lsof instead of treating inspection failure as a free port", async () => {
		execFileSync.mockImplementation(() => { throw Object.assign(new Error("lsof unavailable"), { code: "ENOENT" }); });
		await expect(freePort()).rejects.toThrow("lsof unavailable");
		expect(process.kill).not.toHaveBeenCalled();
	});
});
