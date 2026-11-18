# agent-desktop (built-in extension)

Optional native desktop control for Pizza. It wraps the
[agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI
(Apache-2.0, docs at https://agent-browser.dev/desktop) as an execution
tool. Pizza keeps planning, retry, pause, resume, and approval. agent-desktop
has no model loop, and this extension does not add one.

Web pages stay on `_browser` / the `agent-browser` built-in. Do not drive
browser page content through the accessibility tree.

The existing `_computer_use` extension (vendored pi-computer-use) is unchanged.

## Enable

The extension is **off by default**.

```bash
npm install -g agent-desktop          # or: /desktop install, once the extension is loaded
pizza builtin enable agent-desktop    # takes effect on the next session
```

Inside a session that already loaded it: `/desktop enable`, `/desktop status`,
`/desktop permissions`.

### Permissions

macOS 13+ is the supported path. agent-desktop uses the Accessibility (AX)
API. The grant belongs to the app that launches the CLI (Terminal, iTerm, the
Pizza app), not to the shell.

1. `agent-desktop permissions` — report the current state. It does not prompt.
2. `agent-desktop permissions --guide` or `/desktop permissions` — open System
   Settings at the missing pane.
3. Turn on **Accessibility**. Turn on **Screen Recording** only if you need
   `_desktop screenshot`.
4. Run `/desktop status` again. No restart is required.

Windows (UI Automation, Windows 10 1809+, interactive desktop, no grant
dialog, UIPI blocks cross-integrity input) and Linux (AT-SPI, Ubuntu 24.04+,
graphical session) use the same commands when the CLI is installed. They are
not the primary path: `/desktop status` prints the platform limits instead of
pretending the macOS guide applies.

## What the model calls

One command, through Pizza's `cli` tool:

```text
_desktop snapshot --app Notes -i --compact
_desktop click @<snapshot>:eN
_desktop type @<snapshot>:eN "text"
```

Pizza keeps one agent-desktop session per workspace (`session start` once,
then `--session` on later commands). Refs are bound to the workspace and
thread that captured them. After a mutating action, or `_desktop invalidate`,
those refs are refused until the next snapshot. A `STALE_REF` from the CLI
drops the binding too.

Send, pay, delete, quit, notification actions, and controls whose accessible
name matches those verbs wait for Pizza's runtime approval even when safe
mode is off. `batch` and held keys (`key-down`, `mouse-down`, …) are refused
so they cannot skip that check.

Typed text and clipboard writes are stashed outside the event log. The log
records a desensitized `DESKTOP_ACTION` (action, outcome, app, snapshot id,
artifact path) and does not store the vendor envelope, passwords, cookies, or
screenshot bytes.
