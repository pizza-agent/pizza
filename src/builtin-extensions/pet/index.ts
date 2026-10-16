/**
 * Built-in extension: pet
 *
 * A small tamagotchi-style companion for the desktop GUI, in the spirit of
 * codex's pet. The pet is a pure extension — it only uses public API:
 *
 *   pizza.on(agent events)      -> mood/XP state machine (state.ts)
 *   ctx.ui.setWidget()          -> animated frames for the floating desktop window
 *   ctx.ui.page()               -> species picker page (Level-2 picker)
 *   pizza.registerCommand("pet")-> /pet manage command
 *   pizza.registerBuiltinCommand("_pet") -> agent-side cli access
 *
 * Custom species: drop a PetSpeciesDef-shaped JSON into
 * ~/.pizza/agent/pets/<id>.json and it shows up in `/pet adopt`.
 * Save data lives in ~/.pizza/agent/pet.json — the pet is yours across
 * sessions and projects.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import type { AgentToolResult } from "../../core/agent/types.js";
import { applyEvent, effectiveMood, initialPetState, levelForXp, type PetState } from "./state.js";
import {
	deletePetSave,
	findSpecies,
	listAllSpecies,
	loadPetSave,
	savePet,
	type PetSave,
} from "./store.js";
import { framesForMood, type PetMood, type PetSpeciesDef } from "./sprites.js";

export const PET_EXTENSION_ID = "pet";
const WIDGET_KEY = "pet-widget";
const STATUS_KEY = "pet";

const USAGE = `Usage:
  /pet adopt [id]      Pick a pet, or adopt a species directly by id
  /pet status          Show your pet
  /pet feed|play       Interact with your pet (+XP)
  /pet rename <name>   Rename your pet
  /pet customize JSON  Set appearance scale and subtitle
  /pet release         Say goodbye (deletes save)
  /pet help            Show this help`;

// ---------------------------------------------------------------------------
// Session-scoped runtime
// ---------------------------------------------------------------------------

interface PetRuntime {
	save: PetSave | undefined;
	species: PetSpeciesDef | undefined;
	state: PetState;
	agentBusy: boolean;
	widgetMounted: boolean;
	ui: ExtensionContext["ui"] | undefined;
}

const runtime: PetRuntime = {
	save: undefined,
	species: undefined,
	state: initialPetState(),
	agentBusy: false,
	widgetMounted: false,
	ui: undefined,
};

function moodStatusText(): string {
	const mood = effectiveMood(runtime.state, { agentBusy: runtime.agentBusy });
	const face: Record<PetMood, string> = {
		idle: "😺",
		working: "😼",
		celebrating: "🎉",
		happy: "😸",
		sad: "😿",
		sleepy: "😴",
		eating: "😋",
	};
	return runtime.save ? `${face[mood]} ${runtime.save.name} Lv.${runtime.state.level}` : "";
}

// Widget frames are pushed as string[] so they work identically in the TUI
// and over RPC (desktop GUI). A session-level interval re-pushes a new frame
// on each animation tick / mood change.

const FRAME_TICK_MS = 800;
let frameTimer: ReturnType<typeof setInterval> | null = null;
let frameIndex = 0;
let lastPushedMood: PetMood | undefined;

function petFrameLines(): string[] {
	const mood = effectiveMood(runtime.state, { agentBusy: runtime.agentBusy });
	if (mood !== lastPushedMood) {
		lastPushedMood = mood;
		frameIndex = 0;
	}
	const frames = framesForMood(runtime.species!, mood);
	const frame = frames[frameIndex % frames.length];
	return frame.split("\n").concat([`${runtime.save!.name} · Lv.${runtime.state.level} · ${mood}`]);
}

function pushFrame(): void {
	frameIndex += 1;
	runtime.ui?.setWidget(WIDGET_KEY, petFrameLines(), {
		placement: "belowEditor",
		meta: petMeta(),
	});
}

/** Structured state for rich surfaces (the desktop floating pet window
 * renders a cartoon face instead of the ASCII frame). */
function petMeta(): Record<string, unknown> | undefined {
	if (!runtime.save || !runtime.species) return undefined;
	const mood = effectiveMood(runtime.state, { agentBusy: runtime.agentBusy });
	return {
		species: runtime.species.id,
		name: runtime.save.name,
		level: runtime.state.level,
		xp: runtime.state.xp,
		mood,
		busy: runtime.agentBusy,
		// The desktop app owns `floating` (written on window open/close). Read it
		// fresh from disk — the in-memory save may predate a Hide, and a stale
		// `true` here makes the bridge reopen the window right after it closes.
		floating: loadPetSave()?.floating ?? null,
		scale: typeof runtime.save.scale === "number" ? runtime.save.scale : 1,
		subtitle: typeof runtime.save.subtitle === "string" ? runtime.save.subtitle : "",
	};
}

function mountWidget(): void {
	if (!runtime.ui || !runtime.save || !runtime.species) return;
	// Widget/status frames only make sense over RPC: the desktop app routes
	// them into the floating pet window. The TUI shows no pet UI — /pet
	// commands still work there for managing the shared save.
	if (runtime.ui.surface !== "rpc") return;
	lastPushedMood = undefined;
	pushFrame();
	if (!frameTimer) frameTimer = setInterval(pushFrame, FRAME_TICK_MS);
	runtime.ui.setStatus(STATUS_KEY, moodStatusText());
	runtime.widgetMounted = true;
}

function unmountWidget(): void {
	if (frameTimer) {
		clearInterval(frameTimer);
		frameTimer = null;
	}
	if (!runtime.ui) return;
	runtime.ui.setWidget(WIDGET_KEY, undefined);
	runtime.ui.setStatus(STATUS_KEY, undefined);
	runtime.widgetMounted = false;
}

function refreshStatus(): void {
	if (runtime.widgetMounted) runtime.ui?.setStatus(STATUS_KEY, moodStatusText());
}

function persist(): void {
	if (!runtime.save) return;
	savePet({ ...runtime.save, xp: runtime.state.xp });
}

/**
 * Lazy-load the pet save: the extension loads once per process, but a pet may
 * be adopted in ANOTHER workspace/process sharing the same agent dir (the
 * desktop GUI runs one sidecar per workspace). Re-read on turn boundaries.
 */
function ensurePetLoaded(): void {
	if (!runtime.save) {
		const save = loadPetSave();
		if (!save) return;
		runtime.save = save;
		runtime.species = findSpecies(save.speciesId);
		runtime.state.xp = save.xp;
		runtime.state.level = levelForXp(save.xp);
	} else {
		// The desktop app writes `floating` directly to pet.json when the
		// floating window opens/closes — keep the in-memory copy in sync.
		runtime.save.floating = loadPetSave()?.floating;
	}
	// The UI context may not have been installed yet at session_start (e.g.
	// RPC mode binds it later) — retry mounting whenever a turn begins.
	if (!runtime.widgetMounted && runtime.species && runtime.ui) mountWidget();
}

function dispatch(kind: Parameters<typeof applyEvent>[1]): void {
	runtime.state = applyEvent(runtime.state, kind);
	persist();
	refreshStatus();
}

// ---------------------------------------------------------------------------
// Picker page (uses the ui.page extension point)
// ---------------------------------------------------------------------------

/**
 * Picker preview: the idle frame as static lines. Static previews are the
 * only kind that survive RPC serialization, keeping TUI and GUI identical.
 */
function previewLines(species: PetSpeciesDef): string[] {
	return framesForMood(species, "idle")[0].split("\n");
}

async function adoptFlow(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/pet adopt needs an interactive UI.", "warning");
		return;
	}
	const species = listAllSpecies();
	const result = await ctx.ui.page("Adopt a pet", {
		items: species.map((s) => ({
			id: s.id,
			label: s.name,
			description: s.description,
			preview: previewLines(s),
		})),
		initialSelection: runtime.save?.speciesId,
	});
	if (result.kind !== "select") return;

	const picked = findSpecies(result.item.id);
	if (!picked) return;
	const name = (await ctx.ui.input("Name your pet", picked.name))?.trim() || picked.name;

	runtime.save = {
		...(runtime.save ?? {}),
		name,
		speciesId: picked.id,
		xp: runtime.state.xp,
		adoptedAt: runtime.save?.adoptedAt ?? Date.now(),
	};
	runtime.species = picked;
	dispatch("adopt");
	if (!runtime.widgetMounted) mountWidget();
	ctx.ui.notify(`You adopted ${name} the ${picked.name}!`, "info");
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handlePetCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [sub, ...rest] = args.trim().split(/\s+/);
	if (ctx.hasUI) runtime.ui = ctx.ui;
	ensurePetLoaded();

	switch ((sub || "status").toLowerCase()) {
		case "adopt": {
			// `/pet adopt <speciesId> [name]` — adopt a known species directly
			// (used by the GUI pets grid); bare `/pet adopt` opens the picker.
			const speciesArg = rest[0];
			if (speciesArg) {
				const picked = findSpecies(speciesArg);
				if (!picked) {
					ctx.ui.notify(`Unknown species "${speciesArg}". Run /pet adopt to browse.`, "warning");
					return;
				}
				const name = rest.slice(1).join(" ").trim() || runtime.save?.name || picked.name;
				runtime.save = {
					...(runtime.save ?? {}),
					name,
					speciesId: picked.id,
					xp: runtime.state.xp,
					adoptedAt: runtime.save?.adoptedAt ?? Date.now(),
				};
				runtime.species = picked;
				dispatch("adopt");
				if (!runtime.widgetMounted) mountWidget();
				ctx.ui.notify(`You adopted ${name} the ${picked.name}!`, "info");
				return;
			}
			await adoptFlow(ctx);
			return;
		}
		case "feed":
		case "play": {
			if (!requirePet(ctx)) return;
			dispatch(sub as "feed" | "play");
			ctx.ui.notify(
				`${runtime.save!.name} ${sub === "feed" ? "eats happily" : "plays with you"}! (+XP)`,
				"info",
			);
			return;
		}
		case "rename": {
			if (!requirePet(ctx)) return;
			const name = rest.join(" ").trim() || (await ctx.ui.input("New name", runtime.save!.name))?.trim();
			if (!name) return;
			runtime.save!.name = name;
			persist();
			refreshStatus();
			ctx.ui.notify(`Your pet is now called ${name}.`, "info");
			return;
		}
		case "customize": {
			if (!requirePet(ctx)) return;
			let options: { scale?: number; subtitle?: string };
			try {
				options = JSON.parse(rest.join(" ")) as { scale?: number; subtitle?: string };
			} catch {
				ctx.ui.notify('Customize expects JSON: /pet customize {"scale":1,"subtitle":"..."}', "warning");
				return;
			}
			if (typeof options.scale === "number" && Number.isFinite(options.scale)) {
				runtime.save!.scale = Math.min(1.5, Math.max(0.7, options.scale));
			}
			if (typeof options.subtitle === "string") runtime.save!.subtitle = options.subtitle.trim().slice(0, 80);
			persist();
			refreshStatus();
			if (runtime.widgetMounted) pushFrame();
			ctx.ui.notify("Pet appearance saved.", "info");
			return;
		}
		case "release": {
			if (!requirePet(ctx)) return;
			const ok = await ctx.ui.confirm("Release pet?", `${runtime.save!.name} will be gone forever.`);
			if (!ok) return;
			deletePetSave();
			runtime.save = undefined;
			runtime.species = undefined;
			runtime.state = initialPetState();
			unmountWidget();
			ctx.ui.notify("Pet released. You can /pet adopt a new one anytime.", "info");
			return;
		}
		case "status": {
			if (!runtime.save || !runtime.species) {
				ctx.ui.notify("No pet yet. Run /pet adopt to pick one.", "info");
				return;
			}
			const mood = effectiveMood(runtime.state, { agentBusy: runtime.agentBusy });
			ctx.ui.notify(
				`${runtime.save.name} the ${runtime.species.name} — Lv.${runtime.state.level} (${runtime.state.xp} XP), mood: ${mood}`,
				"info",
			);
			return;
		}
		case "help":
		default:
			ctx.ui.notify(USAGE, "info");
	}
}

function requirePet(ctx: ExtensionContext): boolean {
	if (!runtime.save) {
		ctx.ui.notify("No pet yet. Run /pet adopt to pick one.", "warning");
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export const createPetExtension: ExtensionFactory = (pizza: ExtensionAPI) => {
	// The extension may be re-created on session reload while the process
	// keeps running: the module-level frame timer from the previous instance
	// would keep pushing frames into a stale UI context. Always clear it and
	// re-mount via the fresh UI context.
	if (frameTimer) {
		clearInterval(frameTimer);
		frameTimer = null;
	}
	runtime.widgetMounted = false;
	// Load save + species once per extension load (session start reload).
	runtime.save = loadPetSave();
	runtime.species = runtime.save ? findSpecies(runtime.save.speciesId) : undefined;
	runtime.state = initialPetState();
	if (runtime.save) runtime.state.xp = runtime.save.xp;
	runtime.state.level = levelForXp(runtime.state.xp);

	pizza.registerCommand("pet", {
		description: "Adopt and care for a terminal pet (tamagotchi-style companion).",
		getArgumentCompletions: (prefix) => {
			const subs = ["adopt", "status", "feed", "play", "rename", "customize", "release", "help"];
			const candidates = prefix === "" || subs.some((s) => s.startsWith(prefix))
				? subs
				: [...subs, ...listAllSpecies().map((s) => `adopt ${s.id}`)];
			const filtered = candidates.filter((s) => s.startsWith(prefix));
			return filtered.length ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: (args, ctx) => handlePetCommand(args, ctx),
	});

	pizza.registerBuiltinCommand({
		name: "_pet",
		description: "Interact with the user's terminal pet (feed/play/status).",
		help: `_pet — built-in command for the pet extension.

  _pet status          pet name, species, level, mood
  _pet feed|play       interact with the pet (+XP)
  _pet rename <name>   rename the pet`,
		parseArguments: (args) => {
			const action = args[0] ?? "status";
			if (!["status", "feed", "play", "rename"].includes(action)) {
				throw new Error(`Unknown _pet action "${action}". Expected: status | feed | play | rename <name>.`);
			}
			return { action, name: args.slice(1).join(" ") };
		},
		execute: async (_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> => {
			const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }] });
			ensurePetLoaded();
			if (!runtime.save || !runtime.species) {
				return text("No pet adopted yet. The user can run /pet adopt.");
			}
			const action = params.action as string;
			if (action === "status") {
				const mood = effectiveMood(runtime.state, { agentBusy: ctx.isIdle() === false });
				return text(`${runtime.save.name} the ${runtime.species.name}: Lv.${runtime.state.level}, ${runtime.state.xp} XP, mood=${mood}`);
			}
			if (action === "rename") {
				const name = (params.name as string).trim();
				if (!name) return text("rename needs a name: _pet rename <name>");
				runtime.save.name = name;
				persist();
				refreshStatus();
				return text(`Pet renamed to ${name}.`);
			}
			dispatch(action as "feed" | "play");
			return text(`You ${action} ${runtime.save.name}. It seems delighted. XP=${runtime.state.xp} Lv.${runtime.state.level}`);
		},
	});

	pizza.on("session_start", (_event, ctx) => {
		runtime.ui = ctx.hasUI ? ctx.ui : undefined;
		runtime.agentBusy = !ctx.isIdle();
		if (runtime.save && runtime.species) mountWidget();
	});

	// RPC mode binds the UI context after session_start — this is the
	// reliable "a UI is attached now" signal for mounting the widget.
	pizza.on("ui_ready", (_event, ctx) => {
		if (ctx.hasUI) runtime.ui = ctx.ui;
		ensurePetLoaded();
	});

	pizza.on("turn_start", (_event, ctx) => {
		runtime.ui = ctx.hasUI ? ctx.ui : runtime.ui;
		runtime.agentBusy = true;
		ensurePetLoaded();
		dispatch("turn_start");
	});

	pizza.on("turn_end", () => {
		runtime.agentBusy = false;
		dispatch("turn_end");
	});

	pizza.on("agent_end", () => {
		runtime.agentBusy = false;
		refreshStatus();
	});

	pizza.on("tool_execution_end", (event) => {
		if (event.isError) dispatch("tool_error");
	});

	pizza.on("session_compact", () => {
		dispatch("compaction");
	});

	pizza.on("session_shutdown", () => {
		persist();
		// Stop the animation loop — the next session re-creates it via
		// mountWidget(). Without this the interval outlives the session.
		unmountWidget();
	});

	// GUI menu contribution: the desktop renders this as an app menu; items
	// steer slash commands into the session or invoke desktop commands.
	const menuHasPet = () => {
		ensurePetLoaded();
		return Boolean(runtime.save);
	};
	pizza.registerMenu({
		id: "pet",
		label: "Pet",
		description: "Your terminal companion",
		// Bespoke settings-page payload: the GUI renders a pets manager
		// (preview + species grid) from this data.
		data: () => ({
			pet: runtime.save
				? {
						name: runtime.save.name,
						speciesId: runtime.save.speciesId,
						xp: runtime.state.xp,
						level: runtime.state.level,
						mood: effectiveMood(runtime.state, { agentBusy: runtime.agentBusy }),
						busy: runtime.agentBusy,
						floating: loadPetSave()?.floating ?? null,
						scale: typeof runtime.save.scale === "number" ? runtime.save.scale : 1,
						subtitle: typeof runtime.save.subtitle === "string" ? runtime.save.subtitle : "",
						adoptedAt: runtime.save.adoptedAt,
					}
				: null,
			species: listAllSpecies(),
		}),
		items: [
			{
				id: "float",
				label: "Float / dock on desktop",
				description: "Toggle the floating pet window",
				uiCommand: "toggle_pet_window",
				visible: menuHasPet,
			},
			{ id: "adopt", label: "Adopt / change pet…", command: "/pet adopt" },
			{
				id: "status",
				label: "Status",
				getValue: () => `Lv.${runtime.state.level}`,
				command: "/pet status",
				visible: menuHasPet,
			},
			{ id: "feed", label: "Feed", command: "/pet feed", visible: menuHasPet },
			{ id: "play", label: "Play", command: "/pet play", visible: menuHasPet },
			{ id: "rename", label: "Rename…", command: "/pet rename", visible: menuHasPet },
			{ id: "release", label: "Release…", command: "/pet release", visible: menuHasPet },
		],
	});

};


