---
name: pizza-customization
description: "Customize and extend Pizza itself. Use when the user wants to add a tool, slash command, keybinding, CLI flag, UI widget, event hook, model provider, skill, prompt template, or theme to Pizza, change its default behavior, manage plugins (pizza plugin/builtin) or provider auth (pizza auth), or bundle resources into an installable plugin package."
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
| Change the project system prompt | `.pizza/SYSTEM.md` (replace) / `.pizza/APPEND_SYSTEM.md` (append) |
| Add/override models or providers without code | `models.json` (or `pizza.registerProvider` in an extension for OAuth/custom streaming) |
| Change defaults (model, approvals, theme, skill commands, …) | `settings.json` |
| Ship several of the above together | **Plugin package** (`pizza` manifest in `package.json`) |
| Bridge Slack/Discord/Telegram/Lark/webhook into a workspace agent | **Channel** config (`channels.json` — built-in adapters, not an extension point) |

Rule of thumb: skills steer the model, extensions change what Pizza *does*.
They compose well — a package can ship an extension plus a skill that teaches
the model when to use it.

## 1. Where things live

Project scope (per repo, typically committed):

    ./.pizza/extensions/  ./.pizza/skills/  ./.pizza/prompts/  ./.pizza/themes/
    ./.pizza/SYSTEM.md    ./.pizza/APPEND_SYSTEM.md

User scope (applies everywhere):

    ~/.pizza/agent/extensions/  ~/.pizza/agent/skills/  ~/.pizza/agent/prompts/
    ~/.pizza/agent/themes/      ~/.agents/skills/  (shared convention dir —
                               where in-app marketplace skill installs land)

Files in `~/.pizza/agent/` (the dir is relocatable via `PIZZA_CODING_AGENT_DIR`):

    settings.json     defaults; project .pizza/settings.json overrides per repo
    keybindings.json  key remapping
    models.json       custom providers/models
    auth.json         provider credentials — managed by `pizza auth` / /login
    extensions.json   plugin registry: installed packages, enabled state,
                      per-resource filters — managed by `pizza plugin`,
                      `pizza builtin`, `pizza config`. Never hand-edit.
    channels.json     Slack/Discord/Telegram/Lark/webhook configs — managed by
                      the Channels tab in the desktop app / gateway

Choose project scope for anything repo-specific (share it via git); user scope
for personal tooling. Name collisions resolve by precedence — project > user >
packages > built-ins — so a user skill can shadow a built-in or package one.

One-off loading without installing: `--extension/-e <path>`, `--skill`,
`--prompt-template`, `--theme` (repeatable). Kill switches:
`--no-extensions/-ne`, `--no-skills/-ns`, `--no-prompt-templates/-np`,
`--no-themes`, `--no-context-files/-nc`, `--no-builtin-extensions`,
`--no-builtin-skills`. `settings.json` keys `extensions`, `skills`, `prompts`,
`themes` add extra paths permanently.

## 2. Writing an extension

An extension is a `.ts` (or `.js`) file whose **default export** is a factory
`(pizza: ExtensionAPI) => void | Promise<void>`. Files are loaded via jiti —
no build step. These specifiers always resolve, even inside the compiled
binary: `pizza`, `typebox` / `@sinclair/typebox`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui` (plus the legacy `@mariozechner/*` names).

Drop `foo.ts` into an extensions dir, or a `foo/` folder with `index.ts`, or a
folder whose `package.json` declares `"pizza": { "extensions": ["entry.js"] }`.

```ts
import { Type } from "typebox";
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

- `pizza.on(event, handler)` — lifecycle hooks: `resources_discover`
  (contribute skill/prompt/theme paths programmatically), `session_start`,
  `session_before_fork`, `session_before_compact` / `session_compact`
  (custom compaction), `session_shutdown`, `session_before_tree` /
  `session_tree`, `context` (mutable message list), `before_agent_start`
  (can replace system prompt), `agent_start` / `agent_end`,
  `after_provider_response`, `turn_start` / `turn_end`,
  `message_start` / `message_update` / `message_end`,
  `tool_execution_start` / `tool_execution_update` / `tool_execution_end`,
  `model_select`, `tool_call` (block or mutate `event.input`), `tool_result`,
  `input` (transform user input), `user_bash`.
- `pizza.registerTool` — TypeBox `parameters`; `promptSnippet` /
  `promptGuidelines` inject into the system prompt; `renderCall` /
  `renderResult` customize TUI display; `execute` streams via `onUpdate`.
- `pizza.registerCommand` — handler gets `ExtensionCommandContext`, which adds
  `waitForIdle`, `newSession`, `fork`, `switchSession`, `navigateTree`, and
  `reload` (hot-reload resources after writing files).
- `pizza.registerShortcut`, `pizza.registerFlag` (new `--flag` CLI options),
  `pizza.registerBuiltinCommand` (in-process `_name` commands the cli tool
  calls before shell fallback), `pizza.registerMessageRenderer`.
  Flag values are injected after factories finish loading — `pizza.getFlag`
  returns `undefined` inside the factory; read it in event/command handlers.
- `pizza.registerProvider` / `unregisterProvider` — custom `baseUrl`, headers,
  `streamSimple`, or OAuth (surfaced via `pizza auth login` / `/login`).
- Actions: `sendMessage`, `sendUserMessage`, `appendEntry` (persist state in
  the session file), `exec` (shell out), `setSessionName`, `setLabel`,
  `getActiveTools` / `setActiveTools` / `getAllTools`, `setModel`,
  `getThinkingLevel` / `setThinkingLevel`, `getCommands` (the `/` palette),
  `events` (shared EventBus).
- `ctx` (handlers' second arg): `ctx.ui` — `select`, `confirm`, `input`,
  `notify`, `setStatus`, `setWidget`, `setFooter`, `setHeader`, `custom`,
  `editor`, `setEditorComponent`, `theme`; plus `ctx.sessionManager`,
  `ctx.modelRegistry`, `ctx.model`, `ctx.cwd`, `ctx.signal`, `ctx.abort()`,
  `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.shutdown()`,
  `ctx.getContextUsage()`, `ctx.compact({ customInstructions })`,
  `ctx.getSystemPrompt()`.

The authoritative reference is `src/core/extensions/types.ts` in the Pizza
repo — read it when unsure; every event and method is doc-commented there.

## 3. The lighter resources

- **Skill**: `<name>/SKILL.md` or flat `<name>.md` in a skills dir; frontmatter
  `name` (matching the folder/file) + `description` telling the model when to
  invoke. Enabled on discovery; invocable as `/skill:<name>` when the
  `enableSkillCommands` setting is on (default).
- **Prompt template**: `<name>.md` in a prompts dir → `/<name> args`. Supports
  `$1…`, `$@`/`$ARGUMENTS`, `${@:N}`/`${@:N:L}` placeholders and `description`,
  `argument-hint` frontmatter.
- **Theme**: `<name>.json` following `packages/tui/theme/theme-schema.json`
  (`name`, `vars`, `colors`; copy `dark.json` as a base). Select via the
  `theme` key in `settings.json` or the theme picker in `/settings`.
- **Keybindings**: `~/.pizza/agent/keybindings.json`.
- **Models**: `~/.pizza/agent/models.json` for static providers; an
  extension's `registerProvider` when OAuth or custom streaming is needed.
- **System prompt**: `.pizza/SYSTEM.md` replaces the base prompt for the repo;
  `.pizza/APPEND_SYSTEM.md` appends to it.

## 4. Packaging and installing plugins

A plugin is a package (npm, git repo, or local dir) whose `package.json` has a
`pizza` manifest declaring which resources to load — `extensions`, `skills`,
`prompts`, `themes` are the only manifest keys:

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

    pizza plugin install npm:@foo/bar | git:github.com/u/r |
        https://github.com/u/r | ssh://git@github.com/u/r | ./local/path
    pizza plugin list | update [source] | remove|uninstall <source>
    pizza plugin enable|disable <source|builtin-id>
    pizza config            # TUI to toggle individual package resources
                            # (per-resource filters live in extensions.json)

Plugins install at user level only — there is no project-scope install; use
`.pizza/` directories for repo-committed resources. `extensions.json` is the
single registry (shared across agent processes, lock-guarded): builtin
extension state, installed packages, and per-resource filters all live there.
Legacy `packages` / `disabledBuiltinExtensions` keys in `settings.json` are
absorbed into it automatically.

Pizza also accepts the `"pi"` manifest used by packages published for the
upstream pi ecosystem (https://pi.dev/packages), and maps pi's module
specifiers (`@earendil-works/pi-coding-agent`, `@mariozechner/pi-coding-agent`,
`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, plus the legacy
`@mariozechner/pi-*` names) onto Pizza's API. Compatibility isn't guaranteed —
pi APIs added after the fork or relying on pi-only features may fail to load
(surface as diagnostics) — so always verify a third-party package after
install. Prefer the `"pizza"` manifest and `pizza` specifier for anything new.

Built-ins ship with Pizza and are toggled, not installed:

    pizza builtin list|enable|disable <id>

covers both built-in extensions (`agent-browser`, `computer-use`) and built-in
skills — note that most built-in skills are **disabled by default** and must
be enabled explicitly (or via `/settings`).

Adjacent surfaces that are configured, not extended:

- **Channels**: Discord/Lark/Slack/Telegram/webhook adapters are compiled in.
  Adding one is a `channels.json` entry (Channels tab or
  `pizza channel run <id>` to debug by hand); adding a *new platform* means
  shipping a new adapter in `packages/channels/`, not writing a plugin.
- **Marketplace skills**: installed in-app via the Skills tab (or
  `install_skill` in RPC) into `~/.agents/skills/` — they're just skills.
- **Auth**: `pizza auth list|login|login-api-key|logout` manages provider
  credentials in `auth.json`; `registerProvider` OAuth flows hook in here.
- **Self-update**: `pizza update [enable|disable]` checks the install channel.

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
- Guard interactive UI behind `ctx.hasUI` — extensions also load in print,
  RPC, and desktop modes where `ctx.ui` dialogs are unavailable.
