import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_EXTENSION_ID,
  createComputerUseExtension,
} from "../src/builtin-extensions/computer-use/index.js";
import {
  BUILTIN_EXTENSIONS,
  getBuiltinExtensionFactories,
  getBuiltinExtensionIds,
} from "../src/builtin-extensions/index.js";

describe("computer-use built-in extension", () => {
  it("is registered in BUILTIN_EXTENSIONS", () => {
    expect(getBuiltinExtensionIds()).toContain(COMPUTER_USE_EXTENSION_ID);
    const ext = BUILTIN_EXTENSIONS.find(
      (e) => e.id === COMPUTER_USE_EXTENSION_ID,
    );
    expect(ext).toBeDefined();
    expect(ext?.factory).toBe(createComputerUseExtension);
  });

  it("is not disabled by default", () => {
    const enabled = getBuiltinExtensionFactories(new Set());
    expect(enabled.some((e) => e.id === COMPUTER_USE_EXTENSION_ID)).toBe(true);
    const disabled = getBuiltinExtensionFactories(
      new Set([COMPUTER_USE_EXTENSION_ID]),
    );
    expect(disabled.some((e) => e.id === COMPUTER_USE_EXTENSION_ID)).toBe(
      false,
    );
  });

  it("registers no native tools — the _computer_use cli command is the only surface", async () => {
    // Load the factory with a stub ExtensionAPI to observe registrations.
    const tools: Array<{ name: string }> = [];
    const builtins: Array<{ name: string }> = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pizza = {
      registerTool: (tool: { name: string }) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
      registerCliCommand: (command: { name: string }) => builtins.push(command),
      on: (event: string) => events.push(event),
    };
    await createComputerUseExtension(pizza as any);
    expect(tools).toEqual([]);
    expect(builtins.map((cmd) => cmd.name)).toEqual(["_computer_use"]);
    expect(commands).toContain("computer");
    // Workflow + shutdown hooks are registered; browser tools are agent-browser's job.
    expect(events).toContain("before_agent_start");
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });
});

it("registers the _computer_use dynamic builtin command via registerCliCommand", async () => {
    const builtins: Array<{ name: string }> = [];
    const pizza = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerCliCommand: (command: { name: string }) =>
        builtins.push(command),
      on: () => undefined,
    };
    await createComputerUseExtension(pizza as any);
    expect(builtins.map((c) => c.name)).toEqual(["_computer_use"]);
  });
