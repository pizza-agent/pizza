<p align="center">
	<img src="./resources/banner.png" alt="Pizza — an event-driven agent without while true" width="760" />
</p>

Pizza is an event-driven agent, without `while true`. Every conversation, tool call, and file edit is an event in an immutable log. Your UI, the LLM context, and the session tree are all projections of that log.

[![npm](https://img.shields.io/npm/v/@tomsun28/pizza)](https://www.npmjs.com/package/@tomsun28/pizza)
[![CI](https://github.com/pizza-agent/pizza/actions/workflows/ci.yaml/badge.svg)](https://github.com/pizza-agent/pizza/actions/workflows/ci.yaml)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

## About It

### Under the hood

- **Reactor-driven turn cycle**
  Unlike `Pi, Claude Code, and Codex`, Pizza does not run the agent loop as a brittle `while true` loop. Each turn is a state machine driven by an event-handler table. The result: interrupts, retries, parallel tool calls, and mid-turn failures can all be handled reliably.

- **The log is the single source of truth**
  Every message, model call, tool result, and file change is written to an immutable `EventStore` (SQLite). The UI, the LLM context, and the session tree are all live projections of that log. State is no longer hidden in mutable objects — it can be rebuilt, audited, and replayed, because the log is the single source of truth.

- **Only one execution tool — the CLI**
  JSON is program-friendly at the API level but not model-friendly. Pizza aggressively gives the model only one tool: the `CLI Tool`. The model uses it to call `_read`, `_write`, `_edit`, and other command-line commands. Surprisingly, it performs better, is more stable, and burns fewer tokens.

- **All interfaces share the same runtime**
  The desktop GUI, interactive TUI, JSON-RPC server, and one-shot print mode all consume the same `SessionFacade` event stream. Script it, embed it, or chat with it directly in the terminal — it is the same agent.

### Memory & collaboration

- **Why New Session**
  In Pizza, you do not need to manually create a new session. Think of it as a long-term task for a friend you can chat with for ten years. A friend will manage their own context.

- **Extreme token efficiency**
  One tool means one small schema on every call — the model never carries a pile of tool definitions. And when context fills up it compacts automatically: old tool results masked for free, a summary only when needed.

- **Git log-like branch tree memory**
  Sessions can fork from any earlier message. Rewind, branch, compare. Restart your life anytime, anywhere.

- **Agents collaborate with agents — free passage between workspaces**
  Any agent can talk and collaborate with another workspace's agent via `tell`. The conversation is continuous — the other side gets the job done in its own workspace, and other projects' details never leak into your context.

### Ecosystem

- **Any SSH host is a workspace**
  Point Pizza at a remote machine and it deploys itself there — the agent works on the remote box like it's a local project.

- **Chat where you already are**
  The gateway connects Slack, Discord, Telegram, Lark, voice, and webhooks to the same agent.

- **It keeps working while you're away**
  Built-in cron scheduling for recurring tasks, plus a persistent "main" agent that's always on.

- **Bring your own model**
  40+ providers — Anthropic, OpenAI, Google, DeepSeek, GLM, Kimi, and more — via API key or OAuth subscription login.

- **Hackable by default**
  MCP servers, skills, hooks, extensions, themes — plus JSON-RPC / FS-RPC modes and an SDK for embedding.

## Quick Start

### Desktop

Download the installer for your platform (macOS / Linux / Windows) from [GitHub Releases](https://github.com/pizza-agent/pizza/releases), install and launch.

**For macOS users**: Since the app is unsigned, you may see "Pizza.app is damaged and can't be opened". Run the following command in Terminal to fix this:

```bash
xattr -cr /Applications/Pizza.app
```

### CLI

```bash
npm install -g @tomsun28/pizza
pizza
```

### One-shot & scripting

```bash
pizza -p "summarize this repo"      # one-shot print mode
pizza --mode rpc                    # JSON-RPC server
pizza --continue                    # resume the previous session
pizza --export session.html         # export a session as a shareable HTML page
```

## Acknowledgements

Pizza's shell comes from Pi → Pizza. Thanks to the Pi project for open-sourcing.

## License

[Apache-2.0](./LICENSE)
