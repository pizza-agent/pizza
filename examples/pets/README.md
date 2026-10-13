# Custom pet species

Drop a JSON file into `~/.pizza/agent/pets/<id>.json` and run `/pet adopt` —
your species shows up in the picker next to the built-in ones.

Shape (`PetSpeciesDef`):

```json
{
  "id": "mushroom",
  "name": "Mushroom",
  "description": "Grows in dark terminals.",
  "frames": {
    "idle": [" .-^-.\n| o o |\n '---'"],
    "happy": [" .-^-.\n| ^ ^ |\n '---'"]
  }
}
```

- `frames` keys are moods: `idle`, `working`, `celebrating`, `happy`, `sad`,
  `sleepy`, `eating`. Any missing mood falls back to `idle`.
- Each frame is ONE multi-line string (use `\n`).
- Multiple strings in an array = animation frames.
- `idle` is required in practice (it is the fallback).

See `mushroom.json` in this directory for a complete example.