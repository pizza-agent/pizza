/**
 * The `_browser` dynamic built-in cli command — the agent-facing surface of
 * the managed-browser engine (src/core/browser).
 *
 *   _browser open <url> [--new]
 *   _browser snapshot
 *   _browser click @e3 | --x 120 --y 40 --frame 12
 *   _browser type @e5 "hello" | --text "hello" --x … --y … --frame …
 *   _browser key Enter
 *   _browser scroll down 600
 *   _browser screenshot
 *   _browser tabs
 *   _browser use t2
 *   _browser wait --url login --ms 5000
 *   _browser downloads
 *   _browser close [t2|all]
 *
 * Like `_computer_use`, this rides the existing cli tool (intercepted before
 * shell fallback) so no per-operation tool schemas enter the model context.
 * The engine (playwright-core) imports lazily on first real use.
 */

import type { AgentToolResult, TextContent } from "../../core/agent/types.js";
import type { BuiltinCommandDefinition } from "../../core/extensions/types.js";
import { BrowserError, getBrowserController } from "../../core/browser/controller.js";
import { chromiumStatusLine } from "../../core/browser/chromium.js";
import { hasNativeBridge, runNative } from "../../core/browser/native-bridge.js";
import type { BrowserTabInfo } from "../../core/browser/types.js";

interface ParsedFlags {
	flags: Map<string, string | boolean>;
	positional: string[];
}

function parseFlags(args: string[], _heredoc?: string): ParsedFlags {
	const flags = new Map<string, string | boolean>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token.startsWith("--")) {
			const name = token.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(name, next);
				i++;
			} else {
				flags.set(name, true);
			}
		} else {
			positional.push(token);
		}
	}
	return { flags, positional };
}

class UsageError extends Error {}

function requireString(flags: ParsedFlags, name: string): string {
	const value = flags.flags.get(name);
	if (typeof value !== "string" || value.length === 0) {
		throw new UsageError(`Missing required --${name} flag.`);
	}
	return value;
}

function optionalNumber(flags: ParsedFlags, name: string): number | undefined {
	const value = flags.flags.get(name);
	if (value === undefined || value === true) return undefined;
	const parsed = Number(value);
	if (Number.isNaN(parsed)) throw new UsageError(`--${name} must be a number, got: ${value}`);
	return parsed;
}

function text(body: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: body } satisfies TextContent], details: undefined };
}

function textResult(body: string): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: body } satisfies TextContent], details: undefined };
}

function formatTab(tab: BrowserTabInfo): string {
	const marker = tab.active ? "*" : " ";
	return `${marker} ${tab.id}  ${truncate(tab.title || tab.url, 48)}  ${tab.url}`;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function helpText(): string {
	return [
		"_browser — drive the managed Chromium (web automation with ARIA refs).",
		"",
		"Subcommands:",
		"  open <url> [--new]        open url; reuses a same-origin tab unless --new",
		"  snapshot                  ARIA snapshot with [ref=eN] element refs",
		"  click <ref|--x --y --frame>  click a ref (preferred) or viewport coordinates",
		"  type <ref> <text>         set input text at ref (or --text with coordinates)",
		"  key <key>                 press a key (Enter, Tab, ArrowDown, a, …)",
		"  scroll [up|down] [amount] scroll the page (default down 600px)",
		"  screenshot                capture the active tab as PNG",
		"  tabs                      list tabs (* = active)",
		"  use <tabId>               activate a tab",
		"  wait [--url substr] [--ms n]  wait for a URL match or fixed delay",
		"  downloads                 list saved downloads",
		"  close [tabId|all]         close a tab or all tabs",
		"  status                    engine + chromium status",
		"",
		"Refs come from `snapshot` and go stale after any page change —",
		"re-snapshot after navigation or clicks that change the page.",
		"Coordinate clicks require --frame from the latest frame_meta/screenshot",
		"epoch; prefer refs.",
		"",
		"Examples:",
		"  _browser open https://example.com",
		"  _browser snapshot",
		'  _browser click @e3',
		'  _browser type @e5 "search text"',
		"  _browser key Enter",
	].join("\n");
}

const SUBCOMMANDS = new Set([
	"open",
	"snapshot",
	"click",
	"type",
	"key",
	"scroll",
	"screenshot",
	"tabs",
	"use",
	"wait",
	"downloads",
	"close",
	"status",
	"help",
]);

async function statusText(): Promise<string> {
	const controller = getBrowserController();
	const state = controller.getState();
	const lines = ["browser-use engine (_browser, managed Chromium via playwright-core)"];
	lines.push("engine: " + (state.available ? "running" : "idle (launches on first use)"));
	lines.push(await chromiumStatusLine());
	lines.push("tabs: " + (state.tabs.length > 0 ? state.tabs.map((t) => t.id).join(", ") : "none"));
	return lines.join("\n");
}

async function runBrowserCommand(subcommand: string, parsed: ParsedFlags, signal: AbortSignal | undefined): Promise<AgentToolResult<Record<string, unknown>>> {
	const controller = getBrowserController();
	if (signal?.aborted) throw new BrowserError("aborted", "aborted before start");

	// Desktop native pane: when the embedded child webview is live (panel
	// open, browser_set_native announced), route the interactive subset
	// through the in-page bridge instead of the managed Chromium.
	if (hasNativeBridge()) {
		switch (subcommand) {
			case "open":
			case "status":
				break; // handled below (open = native navigate)
			case "snapshot":
				return textResult(await runNative("snapshot"));
			case "click": {
				const ref = parsed.positional[0];
				const x = optionalNumber(parsed, "x");
				const y = optionalNumber(parsed, "y");
				if (!ref && (x === undefined || y === undefined)) throw new UsageError("Native pane: click needs a ref (coordinate clicks are mirror-only).");
				if (ref) return textResult(await runNative("click", { ref }));
				break;
			}
			case "type": {
				const ref = parsed.positional[0];
				const body = parsed.positional.slice(1).join(" ");
				const textInput = typeof parsed.flags.get("text") === "string" ? requireString(parsed, "text") : body;
				if (!ref) throw new UsageError("Native pane: type needs a ref.");
				return textResult(await runNative("type", { ref, text: textInput }));
			}
			case "key":
				if (!parsed.positional[0]) throw new UsageError("Usage: _browser key <Enter|Tab|a|…>");
				return textResult(await runNative("key", { key: parsed.positional[0] }));
			case "scroll":
				return textResult(await runNative("scroll", {
					direction: parsed.positional[0] === "up" ? "up" : "down",
					amount: optionalNumber(parsed, "amount") ?? (parsed.positional[1] !== undefined ? Number(parsed.positional[1]) : undefined),
				}));
			case "close": {
				const target = parsed.positional[0];
				if (target && target !== "all") {
					await runNative("close", { tabId: target });
					return textResult(`closed ${target}`);
				}
				await runNative("close");
				return textResult(target === "all" ? "closed all native tabs" : "closed the active native tab");
			}
			case "tabs":
				return textResult(await runNative("tabs"));
			case "use": {
				const id = parsed.positional[0];
				if (!id) throw new UsageError("Usage: _browser use <tabId>");
				return textResult(await runNative("activate", { tabId: id }));
			}
			case "wait":
			case "downloads":
				return textResult(`(native pane: '${subcommand}' is managed-Chromium only — no mirror tabs here)`);
			case "screenshot":
				return textResult("(native pane: the page is visible in the Browser panel; screenshots need the mirror engine)");
			default:
				break;
		}
		if (subcommand === "open") {
			const url = parsed.positional[0] ?? requireString(parsed, "url");
			await runNative("navigate", { url, newTab: parsed.flags.get("new") === true });
			return textResult(`opened ${url} in the embedded browser pane`);
		}
	}

	switch (subcommand) {
		case "open": {
			const url = parsed.positional[0] ?? requireString(parsed, "url");
			const info = await controller.open(url, { newTab: parsed.flags.get("new") === true, source: "agent" });
			return textResult(`opened ${info.url}\nactive tab: ${info.id} (${truncate(info.title || info.url, 60)})`);
		}
		case "snapshot": {
			const snapshot = await controller.snapshot();
			return textResult(snapshot || "(empty snapshot)");
		}
		case "click": {
			const ref = parsed.positional[0];
			const x = optionalNumber(parsed, "x");
			const y = optionalNumber(parsed, "y");
			const frameId = optionalNumber(parsed, "frame");
			await controller.click(ref ? { ref } : { x, y, frameId });
			return textResult("clicked");
		}
		case "type": {
			const ref = parsed.positional[0];
			const body = parsed.positional.slice(1).join(" ") ?? "";
			const textInput = typeof parsed.flags.get("text") === "string" ? requireString(parsed, "text") : body;
			if (!textInput) throw new UsageError("Provide the text to type (positional after the ref, or --text).");
			const x = optionalNumber(parsed, "x");
			const y = optionalNumber(parsed, "y");
			const frameId = optionalNumber(parsed, "frame");
			await controller.type(ref ? { ref, text: textInput } : { text: textInput, x, y, frameId });
			return textResult(`typed ${textInput.length} chars`);
		}
		case "key": {
			const key = parsed.positional[0];
			if (!key) throw new UsageError("Usage: _browser key <Enter|Tab|a|…>");
			await controller.key(key);
			return textResult(`pressed ${key}`);
		}
		case "scroll": {
			const direction = parsed.positional[0] === "up" ? "up" : "down";
			const amount = optionalNumber(parsed, "amount") ?? (parsed.positional[1] !== undefined ? Number(parsed.positional[1]) : undefined);
			const ref = typeof parsed.flags.get("ref") === "string" ? requireString(parsed, "ref") : undefined;
			await controller.scroll({ direction, amount, ref });
			return textResult(`scrolled ${direction}`);
		}
		case "screenshot": {
			const bytes = await controller.screenshot();
			return {
				content: [
					{ type: "text", text: `screenshot (${bytes.length} bytes PNG)` } satisfies TextContent,
					{
						type: "image" as const,
						data: bytes.toString("base64"),
						mimeType: "image/png",
					},
				],
				details: undefined,
			};
		}
		case "tabs": {
			const tabs = controller.listTabs();
			return textResult(tabs.length > 0 ? tabs.map(formatTab).join("\n") : "no tabs");
		}
		case "use": {
			const id = parsed.positional[0];
			if (!id) throw new UsageError("Usage: _browser use <tabId>");
			const info = await controller.use(id);
			return textResult(`active tab: ${info.id} ${info.url}`);
		}
		case "wait": {
			const urlSubstring = typeof parsed.flags.get("url") === "string" ? requireString(parsed, "url") : undefined;
			const ms = optionalNumber(parsed, "ms");
			if (!urlSubstring && ms === undefined) throw new UsageError("Usage: _browser wait --url <substr> | --ms <n>");
			const message = await controller.waitFor({ urlSubstring, ms });
			return textResult(message);
		}
		case "downloads": {
			const downloads = controller.listDownloads();
			return textResult(
				downloads.length > 0
					? downloads.map((d) => `${new Date(d.at).toISOString()}  ${d.filename}  ${d.path}`).join("\n")
					: "no downloads",
			);
		}
		case "close": {
			const target = parsed.positional[0];
			const { closed } = await controller.close(target);
			return textResult(closed.length > 0 ? `closed: ${closed.join(", ")}` : "nothing to close");
		}
		case "status": {
			return textResult(await statusText());
		}
		default:
			throw new UsageError(`Unknown _browser subcommand: ${subcommand}\n\n${helpText()}`);
	}
}

/** The `_browser` dynamic built-in cli command definition. */
export const browserBuiltinCommand: BuiltinCommandDefinition = {
	name: "_browser",
	description:
		"Drive the managed Chromium browser (browser-use): open/snapshot/click/type/key/scroll/screenshot/tabs/use/wait/downloads/close/status with ARIA refs.",
	help: helpText(),
	parseArguments(args) {
		const first = args[0]?.toLowerCase();
		if (!first || first === "help" || first === "-h" || first === "--help") {
			throw new UsageError(helpText());
		}
		if (!SUBCOMMANDS.has(first)) {
			throw new UsageError(`Unknown _browser subcommand: ${args[0]}\n\n${helpText()}`);
		}
		const parsed = parseFlags(args.slice(1));
		return { subcommand: first, ...Object.fromEntries(parsed.flags), __positional: parsed.positional };
	},
	async execute(toolCallId, params, signal, _onUpdate, ctx) {
		void toolCallId;
		void ctx;
		const subcommand = params["subcommand"] as string;
		// parseArguments flattened flags into params; rebuild the parsed shape.
		const positional = (params["__positional"] as string[]) ?? [];
		const flags = new Map<string, string | boolean>();
		for (const [key, value] of Object.entries(params)) {
			if (key === "subcommand" || key === "__positional") continue;
			flags.set(key, value as string | boolean);
		}
		const parsed: ParsedFlags = { flags, positional };
		const controller = getBrowserController();
		// Surface "agent is operating the browser" on the panel while the
		// command runs (read-only subcommands included — cheap and honest).
		controller.setAgentActive(true);
		try {
			return await runBrowserCommand(subcommand, parsed, signal);
		} catch (error) {
			if (error instanceof UsageError) {
				return text(error.message);
			}
			const message = error instanceof Error ? error.message : String(error);
			const code = error instanceof BrowserError ? error.code : "error";
			return text(`_browser ${subcommand} failed (${code}): ${message}`);
		} finally {
			controller.setAgentActive(false);
		}
	},
};

/** Short prompt hint for before_agent_start (kept to ~8 lines of value). */
export const BROWSER_USE_PROMPT_HINT = `## browser-use (built-in)

For web automation prefer the \`_browser\` cli command (managed Chromium, no separate browser needed):

  _browser open <url>        # open page (reuses same-site tab)
  _browser snapshot          # ARIA tree with [ref=eN] refs — read pages with this
  _browser click @e3         # act on a ref (refs go stale after page changes: re-snapshot)
  _browser type @e5 "text"   # fill an input; _browser key Enter to submit

Also: tabs / use t2 / scroll / screenshot / wait --url <substr> / downloads / close. Run \`_browser\` with no args for full help. If the engine cannot find Chromium, tell the user to run /browser install.`;
