import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeDevice } from "../src/core/mcp/oauth/device.js";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn(async (_ms, _value, options) => { options?.signal?.throwIfAborted(); }),
}));
const device = { device_code: "private-device-code", user_code: "PZZA-TEST", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 2 };
const tokens = { access_token: "test-token", token_type: "bearer", scope: "repo" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(values: unknown[]) {
	const fetch = vi.fn(async () => json(values.shift()));
	const onPrompt = vi.fn();
	return { fetch, onPrompt, clientId: "pizza-client", deviceAuthorizationUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", scope: "repo read:user" };
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("OAuth device authorization", () => {
	it("polls pending/slow_down at the required intervals and exchanges without a secret", async () => {
		const options = setup([device, { error: "authorization_pending" }, { error: "slow_down" }, tokens]);
		expect(await authorizeDevice(options)).toEqual(tokens);
		expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([2000, 2000, 7000]);
		expect(options.onPrompt).toHaveBeenCalledWith({ userCode: device.user_code, verificationUri: device.verification_uri, expiresAt: expect.any(Number) });
		const calls = options.fetch.mock.calls as unknown as [URL, RequestInit][];
		expect(String(calls[0][1].body)).toContain("scope=repo+read%3Auser");
		const body = calls[1][1].body as URLSearchParams;
		expect(Object.fromEntries(body)).toEqual({ client_id: "pizza-client", device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
	});
	it.each(["access_denied", "expired_token"])("stops on %s without polling again", async (error) => {
		const options = setup([device, { error }]);
		await expect(authorizeDevice(options)).rejects.toMatchObject({ code: error });
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});
	it("gives actionable guidance when the product app has Device Flow disabled", async () => {
		const options = setup([{ error: "device_flow_disabled" }]);
		await expect(authorizeDevice(options)).rejects.toThrow("Enable Device Flow");
		expect(options.onPrompt).not.toHaveBeenCalled();
	});
	it("cancels while waiting without sending another token request", async () => {
		const abort = new AbortController();
		const options = setup([device]);
		options.onPrompt.mockImplementation(() => abort.abort());
		await expect(authorizeDevice({ ...options, signal: abort.signal })).rejects.toThrow();
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});
	it("expires the local polling deadline even if the server keeps returning pending", async () => {
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const options = setup([device]);
		options.onPrompt.mockImplementation(() => deadline.abort());
		await expect(authorizeDevice(options)).rejects.toMatchObject({ code: "expired_token" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...device, expires_in: 0 }, { ...device, interval: -1 },
		{ ...device, device_code: "" }, { ...device, verification_uri: "javascript:alert(1)" },
	])("rejects malformed device responses before opening a browser", async (invalid) => {
		const options = setup([invalid]);
		await expect(authorizeDevice(options)).rejects.toThrow();
		expect(options.onPrompt).not.toHaveBeenCalled();
	});
	it("never sends device credentials to an insecure endpoint", async () => {
		const options = setup([]);
		await expect(authorizeDevice({ ...options, tokenUrl: "http://example.com/token" })).rejects.toThrow("non-HTTPS");
		expect(options.fetch).not.toHaveBeenCalled();
	});
});
