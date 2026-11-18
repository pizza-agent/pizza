# provenance-lens

`_why` explains a file or event change from Pizza's immutable event log. It is deterministic, read-only, and does not call a model.

## Usage

```text
_why src/auth.ts
_why --event 01J...
_why --tool-call tc_123
_why src/auth.ts --limit 5
_why src/auth.ts --json
```

It walks `caused_by` links to collect:

- the user request
- the tool call and its result
- the file mutation
- approvals/rejections
- shell observations

Output is a compact evidence chain, not raw event JSON. `--json` returns the same evidence for scripts/UI.

## Why

Pizza is event-sourced; `FILE_MUTATION_APPLIED` and `TOOL_EXECUTION_END` already carry causal links. This command turns that audit trail into a user-facing answer: **why did this change happen?**

No model calls and no log replay are required.
