---
name: pizza-customization
description: "Customize and extend Pizza itself. Use when the user wants to add a tool, slash command, keybinding, CLI flag, UI widget, event hook, model provider, skill, prompt template, or theme to Pizza, change its default behavior, or bundle resources into an installable plugin package (pizza plugin install)."
---

# Pizza Customization

Pizza is designed to be reshaped by its users. Tools, slash commands, UI,
keybindings, themes, prompt templates, skills, and model providers can all be
changed by dropping files into conventional directories — no fork, no rebuild,
no registration step. Pick the lightest mechanism that does the job, write it,
and verify it loads.

## 0. Pick the right mechanism

| The user wants to… | Mechanism |
| Add an LLM-callable tool, slash command, shortcut, CLI flag, UI widget, event hook, or model provider | **Extension** (a `.ts`/`.js` file) |
| Teach the agent when/how to do a task (model-invoked instructions) | **Skill** (`SKILL.md`) |
| Reusable user-invoked prompt (`/name args`) | **Prompt template** (`.md`) |
| Change colors / TUI styling | **Theme** (`.json`) |
| Rebind keys | `keybindings.json` |
| Add/override models or providers without code | `models.json` (or `pizza.registerProvider` in an extension for OAuth/custom streaming) |
| Change defaults (model, approvals, theme, …) | `settings.json` |
| Ship several of the above together | **Plugin package** (`pizza` manifest in `package.json`) |

Rule of thumb: skills steer the model, extensions change what Pizza *does*.
They compose well — a package can ship an extension plus a skill that teaches
the model when to use it.

## 1. Where things live

Project scope (per repo, typically committed):

    ./.pizza/extensions/  ./.pizza/skills/  ./.pizza/prompts/  ./.pizza/themes/

User scope (applies everywhere):

    ~/.pizza/agent/extensions/  ~/.pizza/agent/skills/  ~/.pizza/agent/prompts/
    ~/.pizza/agent/themes/      ~/.agents/skills/  (shared convention dir)

Files in `~/.pizza/agent/`:

    settings.json     defaults; project .pizza/settings.json overrides per repo
    keybindings.json  key remapping
    models.json       custom providers/models
    extensions.json   plugin + built-in state — managed by `pizza plugin`,
                      don't hand-edit

Choose project scope for anything repo-specific (share it via git); user scope
for personal tooling. Name collisions resolve by precedence — project > user >
packages > built-ins — so a user skill can shadow a built-in or package one.

One-off loading without installing: `--extension/-e <path>`, `--skill`,
`--prompt-template`, `--theme` (repeatable); `--no-<kind>` disables a class.
`settings.json` keys `extensions`, `skills`, `prompts`, `themes` add extra
paths permanently.

## 2. Writing an extension

An extension is a `.ts` (or `.js`) file whose **default export** is a factory
`(pizza: ExtensionAPI) => void | Promise<void>`. Files are loaded via jiti —
no build step. Inside an extension these imports always resolve (even in the
compiled binary): `pizza`, `@sinclair/typebox`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`.

Drop `foo.ts` into an extensions dir, or a `foo/` folder with `index.ts`, or a
folder whose `package.json` declares `"pizza": { "extensions": ["entry.js"] }`.

```ts
import { Type } from "@sinclair/typebox";
import { isToolCallEventType, type ExtensionAPI } from "pizza";

export default function (pizza: ExtensionAPI) {
	// LLM-callable tool (TypeBox schema)
	pizza.registerTool({
		name: "hello",
		label: "Hello",
		description: "Say hello to someone",
		parameters: Type.Object({ who: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `Hello, ${params.who}!` }] };
		},
	});

	// Slash command: /hi
	pizza.registerCommand("hi", {
		description: "Greet the user",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.notify("hi!");
		},
	});

	// Event hook: guard dangerous commands (isToolCallEventType narrows input)
	pizza.on("tool_call", (event) => {
		if (isToolCallEventType("bash", event) && /\brm\s+-rf\s+\//.test(event.input.command)) {
			return { block: true, reason: "refusing rm -rf /" };
		}
	});
}
```

API surface (methods on `pizza`):

- `pizza.on(event, handler)` — lifecycle hooks: `session_start`, `context`
  (mutable message list), `before_agent_start` (can replace system prompt),
  `turn_start`/`turn_end`, `message_*`, `tool_call` (block or mutate
  `event.input`), `tool_result`, `input` (transform user input), `user_bash`,
  `session_before_compact` (custom compaction), `model_select`,
  `resources_discover` (contribute skill/prompt/theme paths programmatically).
- `pizza.registerTool` — TypeBox `parameters`; `promptSnippet` /
  `promptGuidelines` inject into the system prompt; `renderCall` /
  `renderResult` customize TUI display; `execute` streams via `onUpdate`.
- `pizza.registerCommand` — handler gets `ExtensionCommandContext`, which adds
  `newSession`, `fork`, `switchSession`, `navigateTree`, `waitForIdle`,
  `reload` (hot-reload resources after writing files).
- `pizza.registerShortcut`, `pizza.registerFlag` (new `--flag` CLI options,
  read via `pizza.getFlag`), `pizza.registerBuiltinCommand` (in-process
  `_name` commands the cli tool calls before shell fallback),
  `pizza.registerMessageRenderer`.
- `pizza.registerProvider` / `unregisterProvider` — custom `baseUrl`, headers,
  `streamSimple`, or OAuth (`/login` support).
- Actions: `sendMessage`, `sendUserMessage`, `appendEntry` (persist state in
  the session file), `exec` (shell out), `setSessionName`, `setLabel`,
  `getActiveTools`/`setActiveTools`/`getAllTools`, `setModel`,
  `getThinkingLevel`/`setThinkingLevel`, `events` (shared EventBus).
- `ctx` (handlers' second arg): `ctx.ui` — `select`, `confirm`, `input`,
  `notify`, `setStatus`, `setWidget`, `setFooter`, `setHeader`, `custom`,
  `editor`, `setEditorComponent`, `theme` accessors; plus `ctx.sessionManager`,
  `ctx.modelRegistry`, `ctx.model`, `ctx.cwd`, `ctx.signal`, `ctx.abort()`,
  `ctx.getContextUsage()`, `ctx.compact()`, `ctx.getSystemPrompt()`.

The authoritative reference is `src/core/extensions/types.ts` in the Pizza
repo — read it when unsure; every event and method is doc-commented there.

## 3. The lighter resources

- **Skill**: `<name>/SKILL.md` or flat `<name>.md` in a skills dir; frontmatter
  `name` (matching the folder/file) + `description` telling the model when to
  invoke. Enabled on discovery; invoked manually via `/skill:<name>`.
- **Prompt template**: `<name>.md` in a prompts dir → `/<name> args`. Supports
  `$1…`, `$@`/`$ARGUMENTS`, `${@:N:L}` placeholders and `description`,
  `argument-hint` frontmatter.
- **Theme**: `<name>.json` following `packages/tui/theme/theme-schema.json`
  (`name`, `vars`, `colors`; copy `dark.json` as a base). Select via the
  `theme` key in `settings.json` or the theme picker in `/settings`.
- **Keybindings**: `~/.pizza/agent/keybindings.json`.
- **Models**: `~/.pizza/agent/models.json` for static providers; an
  extension's `registerProvider` when OAuth or custom streaming is needed.

## 4. Packaging and installing plugins

A plugin is a package (npm, git repo, or local dir) whose `package.json` has a
`pizza` manifest declaring which resources to load:

```json
{
	"name": "my-pizza-plugin",
	"pizza": {
		"extensions": ["src/index.ts"],
		"skills": ["skills/my-skill"],
		"prompts": ["prompts/review.md"],
		"themes": ["themes/aurora.json"]
	}
}
```

Manage it entirely through the CLI — never edit `extensions.json` by hand:

    pizza plugin install npm:@foo/bar | git:github.com/u/r | ./local/path
    pizza plugin list | enable <src|builtin-id> | disable | update | remove
    pizza config            # TUI to toggle individual package resources

Built-in plugins (`agent-browser`, `computer-use`) and built-in skills are
listed/toggled with `pizza builtin list|enable|disable`.

## 5. Verify

- New/edited resource → `/reload` in a session, an extension command calling
  `ctx.reload()`, or just restart Pizza. Watch startup diagnostics — failed
  extension loads are reported with the path and error.
- Quick smoke test headlessly: `pizza -p "trigger the new thing"`.
- Introspect in-session: `pizza.getAllTools()`, `pizza.getCommands()` from an
  extension; `pizza plugin list`, `pizza builtin list` from a shell.

## Guardrails

- Never modify the installed Pizza itself or hand-edit `extensions.json`;
  user config lives in `~/.pizza/agent/` and the project's `.pizza/`.
- Keep secrets out of extensions and manifests — read env vars at runtime.
- Extensions run in-process with full privileges: write the smallest handler
  that does the job, and prefer blocking/validating in `tool_call` hooks over
  broad changes.
- Guard interactive UI behind `ctx.hasUI` — extensions also load in print/RPC
  mode where `ctx.ui` dialogs are unavailable.
