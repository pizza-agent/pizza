# desktop-capsules

Desktop Workflow Capsules turn a sequence of `_computer_use act` calls into a reusable, selector-based workflow.

## Record

```text
_capsule record monthly-export
_computer_use observe
_computer_use search <stateId> --text Export
_computer_use act <stateId> --actions '[{"action":"click","ref":"@e12"}]' --expect '{"text":"Export complete"}'
_capsule stop
```

While recording, every `_computer_use act` inspects its `@e` refs and stores stable `role/title/identifier` selectors alongside the action. Raw `@e` refs are ephemeral and are not trusted for replay.

## Replay

```text
_computer_use observe --root @r3
_capsule play monthly-export --state <freshStateId>
```

Replay resolves each selector against the fresh outline before calling `act_ui`, then carries the new `stateId` through subsequent steps.

## Commands

```text
_capsule record <name>          start recording
_capsule stop                  save the active recording
_capsule cancel                discard the active recording
_capsule list                  list saved capsules
_capsule show <name> [--json]  inspect selectors/steps
_capsule play <name> --state <stateId>
_capsule delete <name>
```

Capsules are stored in `~/.pizza/agent/desktop-capsules/<name>.json` with mode `0600`.

## Limitations

- Replay requires a fresh `_computer_use observe` state.
- Selectors are semantic (`role/title/identifier`); app UI changes can break them.
- Text typed during recording (including secrets) is stored in the capsule. Do not record credentials.
- There is no automatic retry or parameter substitution yet.
- The first version is selector-based; coordinate-only actions remain coordinate-based.
