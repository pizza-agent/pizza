# Agent character

Pizza ships one procedural SVG character. Its silhouette, eyes and mouth are SVG primitives; CSS animates transforms. There are no generated shape assets or image sequences. Its identity is `pizza`. The catalog contains only this code-defined character.

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

`apps/web/src/lib/pet-frames.ts` combines local process frames while preserving the newest saved appearance settings. RPC snapshots and events use the same source key. The sidebar, in-app companion, profile, settings and detached window all use `PetFigure` / `PetSprite`. Settings expression previews affect only that preview, never runtime state. All live snapshots provide an activity object; there is no fallback to the old busy-only protocol.

## Extend the renderer

`apps/web/src/lib/agent-character.ts` separates two contracts:

- `CharacterDefinition`: silhouette, optional crust, accent and face anchors in a 112×112 view box. To add another code-rendered character later, add its rig to `CHARACTERS`, add matching core catalog metadata, and pass the selected rig through the host’s `PetFigure.character` prop.
- `CharacterExpression`: eye width/height/tilt, smiling eyes, mouth path/open amount and body lean. `CHARACTER_EXPRESSIONS` defines the existing moods independently of the artwork. Add a mood to both the core and RPC unions, then define its expression and event mapping.

For a custom code-controlled surface, `PetSprite` also accepts `character` and partial `expression` props directly. Its optional `speechLevel` accepts a normalized 0–1 audio envelope to drive mouth opening and disables the text-speaking loop. An audio analyser must supply that envelope; text streaming uses an expressive animation, not phoneme lip sync.

Plugin menu actions and `pizza.pet.react` remain available for behavior. Character artwork is extended through the code-defined rig and expression interfaces. There is no JSON pack loader, ASCII renderer, runtime species registration, creation skill, retired character fallback or save migration.

Animations stop in hidden documents and offscreen figures. Reduced-motion mode preserves the static expressions while disabling movement and blinking. Pointer tracking writes CSS variables and does not re-render React on every pointer movement.
