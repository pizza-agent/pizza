# context-router

Read-only context selectors for long sessions. This extension deliberately does **not** replace Pizza's default context builder; it exposes the pieces needed to benchmark and then wire a router.

## Commands

```text
_context pins [--budget N] [--limit N] [--json]
_context recent [--budget N] [--json]
_context path <path> [--budget N] [--json]
_context route <query> [--json]
```

- `pins`: explicit user constraints / early decisions
- `recent`: latest observations for next-action work
- `path`: file-scoped long-range evidence
- `route`: deterministic intent router (`pins` for constraint/plan/why, otherwise `recent`)

## Algorithm

- `GoalPins` filters out slash commands and acknowledgements, scores user messages by constraint keywords, keeps the first/latest messages, and applies a token budget.
- `RecentWindow` walks events backwards and packs the newest observations under a token budget.
- `CausalPath` (first version) collects events carrying the target path or its tool-call id.
- Router is intentionally small and inspectable; it is not yet connected to the context builder.

## Non-goals

- no embedding / vector database
- no automatic context-builder replacement
- no cross-workspace graph
- no UI graph visualization

## Evaluation

Use `_context ... --json` to feed a benchmark that measures:

- task success
- tokens per successful task
- steps / attempts
- long-range evidence recall
