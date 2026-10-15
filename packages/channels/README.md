# Pizza Channels

External message integrations (Discord / Lark / Slack / Telegram / webhook) that
deliver inbound messages into a Pizza workspace agent and relay the agent's
replies back out.

```
external platform ──message──▶ channel adapter ──tell──▶ gateway ──▶ workspace agent
external platform ◀──reply──── channel adapter ◀─reply── gateway ◀─── workspace agent
```

## Why this is thin

The gateway already owns the hard parts — agent pool, lifecycle, the uniform
`MessageSource` provenance envelope, and serialization of concurrent messages.
A channel adapter only:

1. receives a platform message,
2. calls `runtime.deliver(workspace, text, provenance(kind, id, sender))`,
3. posts the returned reply back to the platform.

## Layout

Plain source in the main package — compiled with the CLI, shipped in the npm
package and the compiled binary. No sub-packages, no separate build.

```
packages/channels/
  index.ts      registry (type → adapter) + runChannel()
  types.ts      ChannelConfig / ChannelType / ChannelAdapter
  runtime.ts    ChannelRuntime (gateway tell + reply capture) + shared helpers
  discord.ts  lark.ts  slack.ts  telegram.ts  webhook.ts
```

Each adapter is one `ChannelAdapter` object:

```ts
export default {
  validate(config) { … },          // save-time checks   (runs in the gateway)
  async probe(config, fetch) { … }, // UI "Test" button   (runs in the gateway)
  async start(config, runtime) { … return stop; }, // the relay (in the gateway daemon)
} satisfies ChannelAdapter;
```

Platform SDKs are imported **dynamically inside `start`**, so the gateway never
loads them for validate/probe.

## How it runs

The Channels tab saves configs to `<agentDir>/channels.json`. The gateway's
channel supervisor (`packages/gateway/channel-supervisor.ts`) runs each enabled
channel **inside the daemon** through `runChannel`: delivery, event fan-out and
rpc go over an in-process `ChannelBridge` — no adapter subprocesses, no socket
round-trips. `deliver()` resolves with the final reply once the turn
completes; adapters send it in one go (no streaming previews).

Adapters must never `process.exit` mid-run — report unrecoverable platform
failures through `runtime.reportFatal()`, which marks the channel crashed and
puts it through the supervisor's respawn budget. Process-wide mutations (e.g.
patching `https.request` for proxy support) affect the whole daemon.

Proxy: the supervisor resolves `settings.json` `network.proxy` → proxy env →
macOS system proxy and injects it as `HTTPS_PROXY` into the daemon env.
`PIZZA_ANSWER_ALL=1` makes adapters reply to every group message, not only
@mentions.

## Add a new channel

1. Add `packages/channels/<type>.ts` exporting a `ChannelAdapter` (copy
   `webhook.ts` for the simplest example).
2. Add the type to `ChannelType` in `types.ts` and to the registry in `index.ts`.
3. `npm install <sdk>` at the repo root if it needs one.
4. Add the field branch in the UI (`apps/web/src/lib/channels.ts` / ChannelDialog).

## Voice messages

Adapters that receive audio (Lark voice messages today) transcribe it in the
adapter process and deliver the transcript to the agent wrapped in a
`<voice duration="Ns">…</voice>` tag — the agent only ever sees text. Without
a configured provider the platform's `<audio …/>` placeholder is forwarded
unchanged, plus a `[not transcribed]` hint.

Configure in `<agentDir>/settings.json`:

```jsonc
{
  "voice": {
    "provider": "groq",                    // groq | openai-compatible | cli
    "model": "whisper-large-v3-turbo",     // provider default when unset
    "language": "zh",                      // optional BCP-47 hint
    "minDurationMs": 500                   // skip very short clips
    // "baseUrl": "https://api.x.com/v1",  // required for openai-compatible
    // "apiKey": "GROQ_API_KEY",           // env name / "!cmd" / literal —
                                           // else auth.json[provider] → env
    // "command": "whisper-cli -m m.bin -f {file} -nt"  // cli provider
  }
}
```

- **groq** — `POST {baseUrl}/audio/transcriptions` against Groq's whisper
  endpoint. Key order: `voice.apiKey` → `auth.json["groq"]` → `GROQ_API_KEY`.
- **openai-compatible** — same endpoint shape for OpenAI/DeepInfra/etc.
  `baseUrl` required; key falls back to `auth.json["openai-compatible"]` →
  `OPENAI_API_KEY`.
- **cli** — local fallback (whisper.cpp etc.): the clip is written to a temp
  file (converted with ffmpeg to `format`, default `wav`), `{file}` in
  `command` is replaced, stdout becomes the transcript.

Lark needs the `im:resource` scope (in addition to `im:message`) to download
message attachments; voice transcripts ride the same `tell` provenance
envelope as text, so the workspace agent treats them like any other message.
