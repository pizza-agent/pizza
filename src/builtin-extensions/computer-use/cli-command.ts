/**
 * The `_computer_use` dynamic built-in cli command.
 *
 * Exposes the vendored computer-use backend through Pizza's cli tool:
 *
 *   _computer_use roots --text Pizza
 *   _computer_use observe --root @r3
 *   _computer_use search <stateId> --text OK --role button
 *   _computer_use act <stateId> --actions '[{"action":"click","ref":"@e25"}]'
 *
 * Everything runs in-process (the cli tool intercepts before shell fallback),
 * so the backend's in-memory stateId/@ref state machine stays valid across
 * calls and across session restarts (session restore replays the persisted
 * backend details from cli results).
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliCommandDefinition } from "../../core/extensions/types.js";
import {
  executeAct,
  executeExpandUi,
  executeFind,
  executeInspectUi,
  executeObserve,
  executeReadText,
  executeSearchUi,
  executeWaitFor,
} from "./backend/bridge.js";
import { loadComputerUseConfig } from "./backend/config.js";

/**
 * The vendored macOS backend drives this helper app via a local socket.
 * (Shared with index.ts, which wires the install/status slash commands.)
 */
export function macosHelperAppPath(): string {
  const explicit = process.env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const system = path.join("/Applications", "pizza-computer-use.app");
  if (existsSync(system)) return system;
  return path.join(os.homedir(), "Applications", "pizza-computer-use.app");
}

/** Probe the native helper binary. (Shared with index.ts install/status paths.) */
export function helperInstalled(): boolean {
  if (process.platform === "darwin")
    return existsSync(
      path.join(macosHelperAppPath(), "Contents", "MacOS", "bridge"),
    );
  // Windows/Linux helpers are handled by the same setup script; probe the default location.
  const name =
    process.platform === "win32" ? "windows-bridge.exe" : "linux-bridge";
  return existsSync(
    path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", name),
  );
}

export function formatConfigStatus(cwd: string): string {
  const loaded = loadComputerUseConfig(cwd);
  return [
    "computer-use configuration",
    `headless: ${loaded.config.headless ? "enabled" : "disabled"}`,
    `cursor_overlay: ${loaded.config.cursor_overlay ? "enabled" : "disabled"}`,
    "",
    "Sources:",
    ...loaded.sources.map(
      (source) =>
        `- ${source.path}: ${source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found"}`,
    ),
    `- env overrides: ${Object.keys(loaded.env).join(", ") || "none"}`,
  ].join("\n");
}

// ============================================================================
// Argument parsing
// ============================================================================

interface ParsedFlags {
  positionals: string[];
  /** Long flags (kebab-case normalized to camelCase). `true` = valueless flag. */
  flags: Record<string, string | true>;
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function kebabName(camel: string): string {
  return camel.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
}

/** Minimal `--flag value` / `--flag=value` parser. `--` ends flag parsing. */
function parseFlags(args: string[], heredoc?: string): ParsedFlags {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const order: string[] = [];
  let onlyPositional = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (onlyPositional) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositional = true;
      continue;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      if (eq > 2) {
        const name = kebabToCamel(token.slice(2, eq));
        flags[name] = token.slice(eq + 1);
        order.push(name);
        continue;
      }
      const name = kebabToCamel(token.slice(2));
      const next = args[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("--")) {
        flags[name] = next;
        order.push(name);
        i++;
      } else {
        flags[name] = true;
        order.push(name);
      }
      continue;
    }
    positionals.push(token);
  }
  // Heredoc form: `_computer_use act --actions <<EOF ... EOF`. Attach the
  // heredoc body as the value of the LAST valueless flag — the natural intent
  // for large JSON payloads that would otherwise fight shell quoting.
  if (heredoc !== undefined && order.length > 0) {
    const lastName = order[order.length - 1]!;
    if (flags[lastName] === true) flags[lastName] = heredoc;
  }
  return { positionals, flags };
}

class UsageError extends Error {}

function requireFlag(
  flags: Record<string, string | true>,
  name: string,
): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`Missing required --${kebabName(name)} flag.`);
  }
  return value.trim();
}

function optionalFlag(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function optionalInt(
  flags: Record<string, string | true>,
  name: string,
  min?: number,
  max?: number,
): number | undefined {
  const raw = optionalFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new UsageError(`--${kebabName(name)} must be a number, got: ${raw}`);
  const truncated = Math.trunc(value);
  if (min !== undefined && truncated < min)
    throw new UsageError(`--${kebabName(name)} must be >= ${min}`);
  if (max !== undefined && truncated > max)
    throw new UsageError(`--${kebabName(name)} must be <= ${max}`);
  return truncated;
}

function optionalJson<T>(
  flags: Record<string, string | true>,
  name: string,
): T | undefined {
  const raw = optionalFlag(flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new UsageError(
      `--${kebabName(name)} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function optionalEnum<T extends string>(
  flags: Record<string, string | true>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = optionalFlag(flags, name);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase() as T;
  if (!allowed.includes(lowered)) {
    throw new UsageError(
      `--${kebabName(name)} must be one of: ${allowed.join(" | ")} (got: ${raw})`,
    );
  }
  return lowered;
}

function requireStateId(parsed: ParsedFlags, usage: string): string {
  const stateId = parsed.positionals[0];
  if (!stateId)
    throw new UsageError(`Missing <stateId> positional.\n\n${usage}`);
  return stateId;
}

// ============================================================================
// Subcommands
// ============================================================================

interface Subcommand {
  usage: string;
  parse(parsed: ParsedFlags): Record<string, unknown>;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  roots: {
    usage:
      "_computer_use roots [--text <text>] [--app <name>] [--bundle-id <id>] [--pid <pid>] [--kind window,menu,sheet,popover,dialog]",
    parse(parsed) {
      const params: Record<string, unknown> = {};
      const text = optionalFlag(parsed.flags, "text");
      if (text) params.text = text;
      const app = optionalFlag(parsed.flags, "app");
      if (app) params.app = app;
      const bundleId = optionalFlag(parsed.flags, "bundleId");
      if (bundleId) params.bundleId = bundleId;
      const pid = optionalInt(parsed.flags, "pid");
      if (pid !== undefined) params.pid = pid;
      const kind = optionalEnum(parsed.flags, "kind", [
        "window",
        "menu",
        "sheet",
        "popover",
        "dialog",
      ] as const);
      if (kind) params.kind = kind;
      return params;
    },
  },
  observe: {
    usage:
      "_computer_use observe [--root <@rN>] [--mode semantic,visual,fused]",
    parse(parsed) {
      const params: Record<string, unknown> = {};
      const root = optionalFlag(parsed.flags, "root");
      if (root) params.root = root;
      const mode = optionalEnum(parsed.flags, "mode", [
        "semantic",
        "visual",
        "fused",
      ] as const);
      if (mode) params.mode = mode;
      return params;
    },
  },
  search: {
    usage:
      "_computer_use search <stateId> [--text <text>] [--role <role>] [--capability <capability>]",
    parse(parsed) {
      const params: Record<string, unknown> = {
        stateId: requireStateId(parsed, this.usage),
      };
      const text = optionalFlag(parsed.flags, "text");
      if (text) params.text = text;
      const role = optionalFlag(parsed.flags, "role");
      if (role) params.role = role;
      const capability = optionalFlag(parsed.flags, "capability");
      if (capability) params.capability = capability;
      return params;
    },
  },
  expand: {
    usage: "_computer_use expand <stateId> --ref <@eN> [--depth <1-8>]",
    parse(parsed) {
      const params: Record<string, unknown> = {
        stateId: requireStateId(parsed, this.usage),
        ref: requireFlag(parsed.flags, "ref"),
      };
      const depth = optionalInt(parsed.flags, "depth", 1, 8);
      if (depth !== undefined) params.depth = depth;
      return params;
    },
  },
  inspect: {
    usage: "_computer_use inspect <stateId> --ref <@eN>",
    parse(parsed) {
      return {
        stateId: requireStateId(parsed, this.usage),
        ref: requireFlag(parsed.flags, "ref"),
      };
    },
  },
  act: {
    usage:
      "_computer_use act <stateId> --actions <JSON array, 1-20 actions> [--expect <JSON condition>]",
    parse(parsed) {
      const params: Record<string, unknown> = {
        stateId: requireStateId(parsed, this.usage),
        actions: optionalJson(parsed.flags, "actions"),
      };
      if (!Array.isArray(params.actions)) {
        throw new UsageError(
          `--actions must be a JSON array of action objects.\n\n${this.usage}\n\nExample: --actions '[{"action":"click","ref":"@e25"}]'`,
        );
      }
      const expect = optionalJson<Record<string, unknown>>(
        parsed.flags,
        "expect",
      );
      if (expect) params.expect = expect;
      return params;
    },
  },
  read: {
    usage: "_computer_use read <stateId> --ref <@eN or @oN> [--offset <n>]",
    parse(parsed) {
      const params: Record<string, unknown> = {
        stateId: requireStateId(parsed, this.usage),
        ref: requireFlag(parsed.flags, "ref"),
      };
      const offset = optionalInt(parsed.flags, "offset", 0);
      if (offset !== undefined) params.offset = offset;
      return params;
    },
  },
  wait: {
    usage:
      "_computer_use wait <stateId> [--ref <@eN>] [--scope-ref <@eN>] [--text <text>] [--role <role>] [--value <value>] [--until present,absent] [--timeout-ms <100-60000>]",
    parse(parsed) {
      const params: Record<string, unknown> = {
        stateId: requireStateId(parsed, this.usage),
      };
      for (const key of ["ref", "scopeRef", "text", "role", "value"] as const) {
        const value = optionalFlag(parsed.flags, key);
        if (value) params[key] = value;
      }
      const until = optionalEnum(parsed.flags, "until", [
        "present",
        "absent",
      ] as const);
      if (until) params.until = until;
      const timeoutMs = optionalInt(parsed.flags, "timeoutMs", 100, 60000);
      if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
      return params;
    },
  },
};

/** Subcommand name -> matching bridge executor (the native tools' execute fns). */
const EXECUTORS = {
  roots: executeFind,
  observe: executeObserve,
  search: executeSearchUi,
  expand: executeExpandUi,
  inspect: executeInspectUi,
  act: executeAct,
  read: executeReadText,
  wait: executeWaitFor,
} as const;

function helpText(): string {
  return [
    "_computer_use - Drive desktop apps via structured UI observation",
    "",
    "Description:",
    "  cli front-end for the computer-use backend. Runs in-process, so",
    "  stateId and @e refs stay valid across calls. Use the returned",
    "  successor stateId for follow-ups.",
    "  For web pages prefer agent-browser; use this for native desktop apps.",
    "",
    "Subcommands:",
    "  roots    List controllable app roots as @r refs.",
    "  observe  Capture one root -> stateId + @e refs.",
    "  search   Query the cached outline.",
    "  expand   Unfold local outline context.",
    "  inspect  Inspect one ref in detail.",
    "  act      Click/type/press with optional expect postcondition.",
    "  read     Read a fixed-size page from a ref.",
    "  wait     Wait for a scoped condition.",
    "  status   Helper install + configuration status.",
    "",
    "Usage:",
    ...Object.values(SUBCOMMANDS).map((entry) => `  ${entry.usage}`),
    "  _computer_use status",
    "  _computer_use help",
    "",
    "Examples:",
    "  _computer_use roots --text Pizza",
    "  _computer_use observe --root @r3",
    "  _computer_use search 57b5 --text OK --role button",
    `  _computer_use act 57b5 --actions '[{"action":"click","ref":"@e25"}]' --expect '{"text":"OK"}'`,
    "  _computer_use wait 57b5 --text DONE --timeout-ms 8000",
  ].join("\n");
}

function statusText(cwd: string): string {
  const installed = helperInstalled();
  const lines = [
    "computer-use built-in extension (_computer_use)",
    `helper installed: ${installed ? "yes" : "no"}${installed ? ` (${macosHelperAppPath()})` : ""}`,
  ];
  if (!installed)
    lines.push(
      "helper not installed — run /computer install (macOS) to set it up.",
    );
  try {
    lines.push(formatConfigStatus(cwd));
  } catch (error) {
    lines.push(
      `configuration: error — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return lines.join("\n");
}

const STATUS_SENTINEL = "__status__";

/** The `_computer_use` dynamic built-in cli command definition. */
export const computerUseBuiltinCommand: CliCommandDefinition = {
  name: "_computer_use",
  description:
    "Drive desktop apps via structured UI observation (computer-use): roots/observe/search/expand/inspect/act/read/wait/status.",
  help: helpText(),
  parseArguments(args, heredoc) {
    const first = args[0]?.toLowerCase();
    if (!first || first === "help" || first === "-h" || first === "--help") {
      // Routed to help output by the cli tool's help handling; parseArguments
      // is only reached with a real subcommand when args are non-empty.
      throw new UsageError(helpText());
    }
    if (first === "status") {
      // status needs cwd at execute time; mark it and keep parseArguments pure.
      return { subcommand: STATUS_SENTINEL };
    }
    const sub = SUBCOMMANDS[first];
    if (!sub) {
      throw new UsageError(
        `Unknown _computer_use subcommand: ${args[0]}\n\n${helpText()}`,
      );
    }
    return {
      subcommand: first,
      ...sub.parse(parseFlags(args.slice(1), heredoc)),
    };
  },
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    const { subcommand, ...rest } = params as { subcommand: string } & Record<
      string,
      unknown
    >;
    if (subcommand === STATUS_SENTINEL) {
      return {
        content: [{ type: "text", text: statusText(ctx.cwd) }],
        details: undefined,
      };
    }
    const executor = EXECUTORS[subcommand as keyof typeof EXECUTORS];
    if (!executor) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown _computer_use subcommand: ${subcommand}`,
          },
        ],
        details: undefined,
      };
    }
    return await executor(
      toolCallId,
      rest as never,
      signal,
      undefined,
      ctx as never,
    );
  },
};
