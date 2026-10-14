---
name: create-pet
description: Create a custom Pizza desktop pet species from the user's concept and save it as a valid species pack.
---

# Create a custom Pizza pet

Help the user design a companion that can be adopted in Pizza. Keep the collaboration lightweight and visual.

## Workflow

1. Ask what the pet should be (animal, creature, object, or character) and for one or two personality or color details. If the user already supplied a clear concept, do not ask again.
2. Invent a short display name and a stable lowercase `id` using only `a-z`, `0-9`, and hyphens. Check `~/.pizza/agent/pets/` before writing. Never overwrite an existing pack; choose a distinct id if necessary.
3. Create `~/.pizza/agent/pets/<id>.json` with a valid species definition. Use concise ASCII sprites that remain legible in a terminal. Give each mood a frame array, and vary frames for idle and working when useful.
4. Confirm the file path and tell the user to choose the new creature from Settings > Extensions > Pet, or run `/pet adopt <id>`.

## Species file format

The top-level object must contain `id`, `name`, optional `description`, and `frames`. `frames` is an object whose keys can only be `idle`, `working`, `celebrating`, `happy`, `sad`, `sleepy`, or `eating`. Every mood value must be a non-empty array of strings. Each string is one multiline ASCII frame. Do not add unsupported metadata inside `frames`.

Example shape:

```json
{
  "id": "moss-fox",
  "name": "Moss Fox",
  "description": "A curious forest companion.",
  "frames": {
    "idle": ["  .-.\n (o.o)\n  | |"],
    "working": ["  .-.\n (o.o)~\n  | |"],
    "celebrating": ["  .-.\n (^o^)\n /|/"],
    "happy": ["  .-.\n (^.^)\n  | |"],
    "sad": ["  .-.\n (;_;)\n  | |"],
    "sleepy": ["  .-.\n (-.-)z\n  | |"],
    "eating": ["  .-.\n (omo)\n  | |"]
  }
}
```

Make the character recognisable at small terminal sizes. Prefer simple silhouettes and expressions over dense art. Validate the JSON before finishing, and preserve all other files in the pets directory.
