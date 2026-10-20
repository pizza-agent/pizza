import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCommandAwait, setRpcWorkspace } from "../apps/web/src/lib/transport.js";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
// @tauri-apps/* resolve to test/stubs via vitest alias (apps/web deps are not
// installed by root npm ci); mock them on the specifier transport.ts imports.
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	setRpcWorkspace(null);
});

describe("pet chat routing", () => {
	it("rejects browser main routing instead of sending to the dev project", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(sendCommandAwait({ type: "prompt", message: "hello" }, 100, true)).rejects.toThrow("desktop app");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("registers before sending and accepts main responses while another project is active", async () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		setRpcWorkspace("/projects/other");
		let receive: (event: { payload: unknown }) => void;
		const unlisten = vi.fn();
		bridge.listen.mockImplementation(async (_event, listener) => {
			receive = listener;
			return unlisten;
		});
		bridge.invoke.mockImplementation(async (_command, args) => {
			expect(receive).toBeTypeOf("function");
			expect(args.targetMain).toBe(true);
			receive({ payload: { id: args.command.id, success: true, _cwd: "/home/user/.pizza/main" } });
			return args.command.id;
		});
		await expect(sendCommandAwait({ type: "prompt", message: "hello" }, 100, true)).resolves.toMatchObject({ success: true });
		expect(unlisten).toHaveBeenCalledOnce();
	});
});
