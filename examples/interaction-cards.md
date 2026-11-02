# Dynamic conversation cards

All agents can use the built-in `_interact` command through `cli`. Main-agent
introductions are one use: neither questions nor a sequence of steps is predefined.
Questions should fit the current task and what the agent already knows.

```sh
_interact --help
_interact capabilities
_interact show <<'JSON'
{
  "title": "How should I help you?",
  "fields": [
    {"id":"name","type":"text","label":"What should I call you?"},
    {"id":"style","type":"select","label":"Answer style","options":[
      {"id":"brief","label":"Brief"},
      {"id":"detailed","label":"Detailed"}
    ]}
  ],
  "allowSkip": true
}
JSON
```

Text, single-choice (`select`) and multiple-choice (`multi`) fields are supported.
The GUI returns a pending record immediately. Stop dependent work and wait for the
user; do not create repeated cards. The user can submit, skip, or answer normally
in chat. Terminal clients use sequential prompts. Headless clients receive the
question JSON and can answer through ordinary input or the RPC below.

## Capabilities

Discover `_interact capabilities` before presenting a capability action. Available
MCP connectors and installed custom servers are contributed by the MCP extension.
An extension can contribute another live provider:

```ts
import { registerInteractionCapabilities } from "@tomsun28/pizza";

let unregister: (() => void) | undefined;
pizza.on("session_start", (_event, ctx) => {
  unregister?.();
  unregister = registerInteractionCapabilities(ctx.sessionManager.eventStore, "calendar", () => [
    {
      id: "calendar:connect",
      label: "Calendar",
      description: "Connect your calendar to help plan your day.",
      status: calendarConnectionState(),
      instructions: "Discover _calendar --help, then connect using _calendar login."
    }
  ]);
});
pizza.on("session_shutdown", () => unregister?.());
```

Offer the returned ID in an action:

```json
{"title":"Connect your calendar?","actions":[{"id":"connect","label":"Connect calendar","capabilityId":"calendar:connect"}],"allowSkip":true}
```

Actions record user intent. They do not contain executable scripts or automatically
run tools. After submission, the agent receives the selected provider's instructions
and uses its existing tools. Selecting connection does not authorize sending email,
posting content, or other unrelated writes. Never collect passwords or tokens in cards.

Marketplace discovery and installation are available through `_agentcli server catalog`
and `_agentcli server install <name>`. Installation preserves existing configurations;
authentication is separate (`_agentcli server login <name>`).

## State and RPC

`INTERACTION_REQUESTED` and `INTERACTION_ANSWERED` events persist cards and answers
in the current thread. Reconnection restores them; foreign-thread answers, expired
requests, invalid options, and conflicting repeated submissions are rejected.
Identical retries return the saved result without another agent turn. One pending
card is allowed per thread. Expiry defaults to 24 hours (`expiresInMinutes` is configurable).

- `{"type":"interaction_list"}` returns records in the active thread.
- `{"type":"interaction_respond","requestId":"<id>","answer":{"kind":"submit","values":{"name":"Tom"}}}` validates and saves the answer, then prompts the agent (or queues a follow-up while it runs).
- Free text: `{"kind":"text","text":"Let's do this later"}`.
- Skip: `{"kind":"skip"}` (when allowed).

Private answers stay in the backend event store rather than browser storage.
Saving a name or preference is the agent's follow-up work: user facts go into user
memory, assistant identity into `SOUL.md`. Unanswered questions are never facts.

## Main-agent initiative

Only sessions created with `isMainAgent: true` register initiative policy. Other
workspaces retain ordinary cards, their project prompts and their own schedules.
The main agent always enables initiative and receives a per-turn policy containing
the current allowance. There is no UI or command to toggle it; `_interact initiative`
is read-only. Older saved off preferences are ignored.

Unsolicited cards must set `initiative: true` and allow skipping. The backend
rejects these cards outside the main runtime, within 24 hours
of the previous proactive card across main-agent conversations. Suggestion history is kept in
the main event store and survives restart. Plain conversational behavior still
relies on the model following its system instructions.

Follow-ups require a user-selected time and agreed read scope. The agent uses the
existing main scheduler with `--max-runs 1`, pinned to the originating chat; it
must confirm creation before promising a reminder. Users manage these tasks with
the existing schedule controls or `_cron pause/delete`. Users can skip a suggestion or cancel a particular follow-up. There is no periodic scan of
connected accounts; checks run only after a user agrees to one.
