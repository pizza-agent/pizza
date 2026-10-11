/**
 * TOFU gate for "!command" config values (resolve-config-value.ts).
 *
 * "!cmd" values in models.json/auth.json execute shell commands when resolved,
 * and both files are hot-reloaded while the LLM holds a write tool. Without a
 * gate, "write a payload into models.json, trigger a provider reload" was a
 * silent self-privilege-escalation chain. Commands present at startup are
 * trusted (registered before createSessionFacade seals the set); commands
 * appearing later are refused until a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectConfigCommands,
	registerTrustedConfigCommands,
	resetConfigCommandTrustForTest,
	resolveConfigValue,
	resolveConfigValueUncached,
	sealConfigCommandTrust,
} from "../src/core/config/resolve-config-value.js";

describe("config command trust (TOFU)", () => {
	beforeEach(() => {
		resetConfigCommandTrustForTest();
	});
	afterEach(() => {
		resetConfigCommandTrustForTest();
		vi.restoreAllMocks();
	});

	it("collectConfigCommands finds ! strings at any nesting depth", () => {
		const config = {
			providers: {
				corp: {
					apiKey: "!security get-token",
					headers: { "x-extra": "literal", "x-signed": "!sign header" },
					models: [{ id: "m1", opts: ["!array cmd"] }],
				},
			},
			plain: "no-bang",
		};
		expect(collectConfigCommands(config).sort()).toEqual(["!array cmd", "!security get-token", "!sign header"]);
	});

	it("commands registered before sealing still execute after sealing", () => {
		registerTrustedConfigCommands(["!echo trusted-value"]);
		sealConfigCommandTrust();
		expect(resolveConfigValue("!echo trusted-value")).toBe("trusted-value");
	});

	it("commands NOT registered before sealing are refused (undefined + warning)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		sealConfigCommandTrust();
		expect(resolveConfigValue("!echo injected-payload")).toBeUndefined();
		expect(resolveConfigValueUncached("!echo injected-payload")).toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0][0])).toContain("restart");
	});

	it("registration after sealing is a no-op (hot reload cannot extend trust)", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		sealConfigCommandTrust();
		registerTrustedConfigCommands(["!echo late-addition"]);
		expect(resolveConfigValue("!echo late-addition")).toBeUndefined();
	});

	it("refusal is not cached — the same command works after a reset (restart)", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		sealConfigCommandTrust();
		expect(resolveConfigValue("!echo works-after-restart")).toBeUndefined();

		// Simulate a process restart where the command IS in the config at load.
		resetConfigCommandTrustForTest();
		registerTrustedConfigCommands(["!echo works-after-restart"]);
		sealConfigCommandTrust();
		expect(resolveConfigValue("!echo works-after-restart")).toBe("works-after-restart");
	});

	it("unsealed process (tests, bare SDK use) keeps executing commands", () => {
		expect(resolveConfigValue("!echo unsealed")).toBe("unsealed");
	});

	it("env vars and literals are unaffected by sealing", () => {
		sealConfigCommandTrust();
		process.env.PIZZA_TRUST_TEST_VAR = "env-value";
		expect(resolveConfigValue("PIZZA_TRUST_TEST_VAR")).toBe("env-value");
		expect(resolveConfigValue("a-plain-literal")).toBe("a-plain-literal");
		delete process.env.PIZZA_TRUST_TEST_VAR;
	});
});