import { describe, expect, it } from "vitest";
import { getTextOutput } from "../src/core/tools/render-utils.js";
import {
  createCliTestTool,
  createCliTestToolDefinition,
} from "./helpers/cli-tool.js";
import type {
  CliCommandDefinition,
  RegisteredCliCommand,
} from "../src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../src/core/skills/source-info.js";
import { computerUseBuiltinCommand } from "../src/builtin-extensions/computer-use/cli-command.js";

/** Minimal dynamic built-in used to exercise cli routing without the real backend. */
function makeEchoCommand(
  overrides?: Partial<CliCommandDefinition>,
): CliCommandDefinition {
  return {
    name: "_echotest",
    description: "test-only dynamic builtin",
    help: "_echotest - test-only dynamic builtin\n\nUsage:\n  _echotest ping [--loud]",
    parseArguments(args) {
      if (args[0] !== "ping")
        throw new Error(`Unknown subcommand: ${args[0] ?? "(none)"}`);
      return { loud: args.includes("--loud") };
    },
    execute: async (_toolCallId, params) => ({
      content: [
        {
          type: "text",
          text: `pong loud=${(params as { loud?: boolean }).loud === true}`,
        },
      ],
      details: undefined,
    }),
    ...overrides,
  };
}

function makeTool(command: CliCommandDefinition) {
  const registered: RegisteredCliCommand = {
    ...command,
    sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }),
  };
  return createCliTestTool(process.cwd(), { dynamicBuiltins: () => [registered] });
}

/** Unwrapped definition: keeps promptSnippet for docs assertions. */
function makeToolDefinition(command: CliCommandDefinition) {
  const registered: RegisteredCliCommand = {
    ...command,
    sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }),
  };
  return createCliTestToolDefinition(process.cwd(), {
    dynamicBuiltins: () => [registered],
  });
}

describe("dynamic built-in cli commands (ExtensionAPI.registerCliCommand)", () => {
  it("routes to the extension executor in-process", async () => {
    const tool = makeTool(makeEchoCommand());
    const result = await tool.execute("t1", { command: "_echotest ping" });
    expect(getTextOutput(result)).toBe("pong loud=false");
    // Inner executor details are plumbed through details.command.details for
    // session restore (the echo command returns none).
    expect(result.details).toEqual({
      command: {
        source: "extension",
        name: "_echotest",
        args: { loud: false },
        details: undefined,
      },
    });
  });

  it("passes parsed params through", async () => {
    const tool = makeTool(makeEchoCommand());
    const result = await tool.execute("t2", {
      command: "_echotest ping --loud",
    });
    expect(getTextOutput(result)).toBe("pong loud=true");
  });

  it("shows help for -h/--help/help and for a bare invocation", async () => {
    const tool = makeTool(makeEchoCommand());
    for (const suffix of ["-h", "--help", "help", ""]) {
      const result = await tool.execute("t3", {
        command: `_echotest ${suffix}`.trim(),
      });
      expect(getTextOutput(result)).toContain(
        "_echotest - test-only dynamic builtin",
      );
    }
  });

  it("surfaces parseArguments errors as is_error guidance", async () => {
    const tool = makeTool(makeEchoCommand());
    await expect(tool.execute("t4", { command: "_echotest bogus" })).rejects.toThrow(
      /Unknown subcommand: bogus/,
    );
    await expect(tool.execute("t4b", { command: "_echotest bogus" })).rejects.toThrow(
      /_echotest --help/,
    );
  });

  it("rejects shell operators instead of falling back to the shell", async () => {
    const tool = makeTool(makeEchoCommand());
    await expect(
      tool.execute("t5", { command: "_echotest ping | cat" }),
    ).rejects.toThrow(/does not support shell operators/);
    // The guidance names the corrected pure command so the caller can retry.
    await expect(
      tool.execute("t5b", { command: "_echotest ping | cat" }),
    ).rejects.toThrow(/Issue the leading part alone: `_echotest ping`/);
    await expect(
      tool.execute("t6", { command: "_echotest ping; echo pwned" }),
    ).rejects.toThrow(/does not support shell operators/);
  });

  it("falls through to the shell for unknown first words", async () => {
    const tool = makeTool(makeEchoCommand());
    const result = await tool.execute("t7", { command: "echo plain-shell" });
    expect(getTextOutput(result)).toContain("plain-shell");
  });

  it("lists dynamic commands in the cli tool description and promptSnippet", () => {
    const definition = makeToolDefinition(makeEchoCommand());
    expect(definition.description).toContain("_echotest");
    expect(definition.promptSnippet).toContain("_echotest");
  });

});

describe("_computer_use builtin command parsing", () => {
  it("parses roots flags into find_roots params", () => {
    const params = computerUseBuiltinCommand.parseArguments([
      "roots",
      "--text",
      "Pizza",
      "--pid",
      "42",
      "--kind",
      "window",
    ]);
    expect(params).toMatchObject({
      subcommand: "roots",
      text: "Pizza",
      pid: 42,
      kind: "window",
    });
  });

  it("parses search positionals + flags into search_ui params", () => {
    const params = computerUseBuiltinCommand.parseArguments([
      "search",
      "57b5",
      "--text",
      "OK",
      "--role",
      "button",
    ]);
    expect(params).toMatchObject({
      subcommand: "search",
      stateId: "57b5",
      text: "OK",
      role: "button",
    });
  });

  it("requires --ref for expand", () => {
    expect(() =>
      computerUseBuiltinCommand.parseArguments(["expand", "57b5"]),
    ).toThrow(/--ref/);
  });

  it("parses act JSON payloads and validates the actions array", () => {
    const params = computerUseBuiltinCommand.parseArguments([
      "act",
      "57b5",
      "--actions",
      '[{"action":"click","ref":"@e25"}]',
      "--expect",
      '{"text":"OK"}',
    ]);
    expect(params.subcommand).toBe("act");
    expect(params.actions).toEqual([{ action: "click", ref: "@e25" }]);
    expect(params.expect).toEqual({ text: "OK" });

    expect(() =>
      computerUseBuiltinCommand.parseArguments([
        "act",
        "57b5",
        "--actions",
        "not-json",
      ]),
    ).toThrow(/valid JSON/);
  });

  it("normalizes kebab-case flags (timeoutMs, scopeRef, bundleId)", () => {
    const wait = computerUseBuiltinCommand.parseArguments([
      "wait",
      "57b5",
      "--scope-ref",
      "@e3",
      "--timeout-ms",
      "8000",
    ]);
    expect(wait).toMatchObject({
      subcommand: "wait",
      scopeRef: "@e3",
      timeoutMs: 8000,
    });
    const roots = computerUseBuiltinCommand.parseArguments([
      "roots",
      "--bundle-id",
      "com.apple.Safari",
    ]);
    expect(roots).toMatchObject({
      subcommand: "roots",
      bundleId: "com.apple.Safari",
    });
  });

  it("marks the status subcommand and executes it with the session cwd", async () => {
    const parsed = computerUseBuiltinCommand.parseArguments(["status"]);
    expect(parsed.subcommand).toBe("__status__");
    const result = await computerUseBuiltinCommand.execute(
      "t8",
      parsed,
      undefined,
      undefined,
      { cwd: process.cwd() } as never,
    );
    const text = result.content
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n");
    expect(text).toContain("computer-use built-in extension (_computer_use)");
    expect(text).toContain("helper installed:");
  });

  it("unknown subcommands list the valid ones", () => {
    expect(() => computerUseBuiltinCommand.parseArguments(["bogus"])).toThrow(
      /Unknown _computer_use subcommand: bogus/,
    );
  });
});
