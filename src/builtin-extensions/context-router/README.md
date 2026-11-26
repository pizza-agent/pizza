# context-router

Read-only context selectors plus explicit, user-owned memory pins for long sessions.

## Selectors

```text
_context pins [--budget N] [--limit N] [--json]
_context recent [--budget N] [--json]
_context path <path> [--budget N] [--json]
_context route <query> [--json]
```

- `pins`: explicit user constraints / early decisions, plus saved memories
- `recent`: latest observations for next-action work
- `path`: file-scoped long-range evidence
- `route`: deterministic intent router (`pins` for constraint/plan/why, otherwise `recent`)

## Memory

```text
_context remember <event_id> [--kind constraint|preference|decision|fact]
                             [--scope session|project|global]
                             [--text "..."] [--confidence 0-1] [--expires ISO]
_context forget <memory_id>
_context memories [--json]
_context export [--json]
```

Memory is written **only by an explicit user command**. It is local JSON under:

```text
~/.pizza/agent/context-memory/memories.json
```

The file is written atomically with mode `0600`. Each item keeps its source event id and scope keys:

```json
{
  "id": "mem_...",
  "kind": "constraint",
  "text": "keep the public API stable",
  "scope": "project",
  "sourceEventId": "01J...",
  "workspaceId": "ws_...",
  "confidence": 1,
  "createdAt": 0,
  "updatedAt": 0,
  "createdBy": "user_explicit"
}
```

- `session` memory is visible only in the session that created it
- `project` memory is visible in the same workspace
- `global` memory is visible everywhere
- `forget` deletes permanently, but only for the current session/project scope
- `export` returns only the current session/project/global-visible items; it never dumps other scopes
- duplicates are scoped by text + scope + source event + workspace/session keys

## Non-goals

- no silent/automatic memory writes
- no embedding / vector database
- no automatic context-builder replacement
- no cross-workspace graph
