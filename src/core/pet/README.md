# Agent character

Pizza ships one procedural SVG character. Its silhouette, eyes and mouth are SVG primitives; CSS animates transforms. There are no generated shape assets or image sequences. `pip` remains its save ID so existing progress and size settings survive the artwork change. Retired builtins migrate to `pip` unless a user pack or plugin owns that ID.

## Runtime to UI

`src/core/pet/session.ts` projects live events into per-session activity. `PetService` combines sessions, publishes `pet_state`, and keeps adoption/XP separate from the runtime expression. `activity` is present even without an adopted companion, so the global assistant has a live face from the start.

| Event | Expression |
| --- | --- |
| Turn/model request, thinking chunks | `thinking` |
| Text chunks | `speaking` |
| Tool execution | `working` |
| Approval or interaction request | `waiting` |
| Successful turn completion | `celebrating`, then idle |
| Turn failure | `sad`, then idle |
| User interrupt / aborted completion | `idle` |

Parallel tools and outstanding approvals are tracked separately. Waiting has priority over execution, text streaming and thinking. Tool-loop boundaries are not treated as completed tasks. An interaction remains waiting after `interaction_pending` completion until answered or expired. Detaching a session clears only its activity. Heartbeats keep long tool calls current; stale sidecar activity expires in the client.

`apps/web/src/lib/pet-frames.ts` combines local process frames without replacing the newest saved identity. RPC snapshots and events use the same source key. The sidebar, in-app companion, profile, settings and detached window all use `PetFigure` / `PetSprite`. Settings expression previews affect only that preview, never runtime state.

## Extend the renderer

`apps/web/src/lib/agent-character.ts` separates two contracts:

- `CharacterDefinition`: silhouette, optional crust, accent and face anchors in a 112×112 view box. Add another entry to `CHARACTERS` and a matching core species entry to ship a new code-rendered character.
- `CharacterExpression`: eye width/height/tilt, smiling eyes, mouth path/open amount and body lean. `CHARACTER_EXPRESSIONS` defines the existing moods independently of the artwork. Add a mood to both the core and RPC unions, then define its expression and event mapping.

For a custom code-controlled surface, `PetSprite` also accepts `character` and partial `expression` props directly. Its optional `speechLevel` accepts a normalized 0–1 audio envelope to drive mouth opening and disables the text-speaking loop. An audio analyser must supply that envelope; text streaming uses an expressive animation, not phoneme lip sync.

User/plugin ASCII packs, plugin menu actions and `pizza.pet.react` remain supported. Old packs fall back to their idle frame for a new mood. The built-in `create-pet` skill documents the pack format.

Animations stop in hidden documents and offscreen figures. Reduced-motion mode preserves the static expressions while disabling movement and blinking. Pointer tracking writes CSS variables and does not re-render React on every pointer movement.
