/**
 * The app pet on the client: one hook every surface (in-app pet, floating
 * window, agent profile, settings) uses. State comes from the core pet
 * service over RPC (`pet_get` / `pet_action`) and live `pet_state` frames.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	RpcPetAction,
	RpcPetCatalog,
	RpcPetMood,
	RpcPetOperation,
	RpcPetSnapshot,
	RpcPetSpecies,
	RpcPetStatus,
} from "@tomsun28/pizza-protocol";
import { isTauri } from "./platform";
import { sendCommandAwait, subscribePetState } from "./transport";

export type PetMood = RpcPetMood;
export type PetStatus = RpcPetStatus;
export type PetSpecies = RpcPetSpecies;
export type PetAction = RpcPetAction;
export type PetCatalog = RpcPetCatalog;
export type PetOperation = RpcPetOperation;
export type PetSnapshot = RpcPetSnapshot;

/** The pet's first-class settings page. */
export const PET_SETTINGS_PATH = "/settings?page=pet";

export const PET_SCALE_MIN = 0.7;
export const PET_SCALE_MAX = 1.5;

/** Mirrors core/pet/state.ts levelForXp. */
export const levelForXp = (xp: number) => Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 10)) + 1);

/** The pet lives with the local main agent, whatever workspace is open. */
const targetMain = () => isTauri();

export async function getPetCatalog(): Promise<PetCatalog> {
	const r = await sendCommandAwait<PetCatalog>({ type: "pet_get" }, 8000, targetMain());
	if (!r.data) throw new Error("Missing pet response");
	return r.data;
}

export async function runPetAction(op: PetOperation): Promise<PetCatalog> {
	const r = await sendCommandAwait<PetCatalog>({ type: "pet_action", op }, 8000, targetMain());
	if (!r.data) throw new Error("Missing pet response");
	return r.data;
}

/** Plugin pet actions are slash commands steered into the main session. */
export async function runPetPluginAction(action: PetAction): Promise<void> {
	await sendCommandAwait({ type: "steer", message: action.command }, 8000, targetMain());
}

/** Desktop first paint: read the shared save before any sidecar answers. */
async function readSave(): Promise<PetStatus | null | undefined> {
	if (!isTauri()) return undefined;
	const { invoke } = await import("@tauri-apps/api/core");
	const save = await invoke<Record<string, unknown> | null>("get_pet_state");
	if (!save || typeof save.speciesId !== "string" || typeof save.name !== "string") return null;
	const xp = typeof save.xp === "number" ? save.xp : 0;
	return {
		name: save.name,
		speciesId: save.speciesId,
		xp,
		level: levelForXp(xp),
		mood: "idle",
		busy: false,
		scale: typeof save.scale === "number" ? save.scale : 1,
		subtitle: typeof save.subtitle === "string" ? save.subtitle : "",
		adoptedAt: typeof save.adoptedAt === "number" ? save.adoptedAt : Date.now(),
		floating: typeof save.floating === "boolean" ? save.floating : null,
	};
}

interface Frame { snapshot: PetSnapshot; at: number }

/** A busy flag nobody refreshed for this long is treated as stale (sidecar gone). */
const BUSY_STALE_MS = 5 * 60_000;

/**
 * Several local sidecars (one per workspace) report the same pet. Identity
 * comes from the newest frame; the pet works while any of them is busy.
 */
export function mergePetFrames(frames: ReadonlyMap<string, Frame>, now = Date.now()): PetSnapshot | undefined {
	let newest: Frame | undefined;
	for (const frame of frames.values()) if (!newest || frame.at >= newest.at) newest = frame;
	const pet = newest?.snapshot.pet;
	if (!newest || !pet) return newest?.snapshot;
	const busy = [...frames.values()].some((f) => f.snapshot.pet?.busy && now - f.at < BUSY_STALE_MS);
	const mood: PetMood = busy ? "working" : pet.mood === "working" ? "idle" : pet.mood;
	return { ...newest.snapshot, pet: { ...pet, busy, mood } };
}

export function usePet() {
	const [snapshot, setSnapshot] = useState<PetSnapshot | undefined>();
	const [catalog, setCatalog] = useState<PetSpecies[]>([]);
	const [actions, setActions] = useState<PetAction[]>([]);
	const [floating, setFloating] = useState(false);
	const [error, setError] = useState("");
	const frames = useRef(new Map<string, Frame>());

	const apply = useCallback((source: string, next: PetSnapshot) => {
		frames.current.set(source, { snapshot: next, at: Date.now() });
		setSnapshot(mergePetFrames(frames.current));
	}, []);
	const applyCatalog = useCallback((next: PetCatalog) => {
		apply("rpc", { pet: next.pet, species: next.species });
		setCatalog(next.catalog);
		setActions(next.actions);
		setError("");
	}, [apply]);

	const refresh = useCallback(async () => {
		try {
			applyCatalog(await getPetCatalog());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [applyCatalog]);

	const act = useCallback(async (op: PetOperation) => {
		const next = await runPetAction(op);
		applyCatalog(next);
		return next;
	}, [applyCatalog]);

	useEffect(() => {
		let disposed = false;
		const cleanups: Array<() => void> = [];
		const add = (fn: () => void) => { if (disposed) fn(); else cleanups.push(fn); };
		void readSave()
			.then((pet) => { if (!disposed && pet !== undefined && frames.current.size === 0) setSnapshot((s) => s ?? { pet, species: null }); })
			.catch(() => {});
		void subscribePetState((frame) => {
			// A remote workspace reports another machine's save.
			if (disposed || frame._cwd?.startsWith("remote://")) return;
			apply(frame._cwd ?? "local", { pet: (frame.pet as PetStatus | null) ?? null, species: (frame.species as PetSpecies | null) ?? null });
		}).then(add).catch(() => {});
		void refresh();
		const onFocus = () => { void refresh(); };
		window.addEventListener("focus", onFocus);
		cleanups.push(() => window.removeEventListener("focus", onFocus));
		if (isTauri()) {
			void import("@tauri-apps/api/event")
				.then(({ listen }) => listen<{ open: boolean }>("pet_window_state", (e) => { if (!disposed) setFloating(e.payload.open); }))
				.then(add).catch(() => {});
			void import("@tauri-apps/api/core")
				.then(({ invoke }) => invoke<boolean>("get_pet_window_state"))
				.then((open) => { if (!disposed) setFloating(open); }).catch(() => {});
		}
		return () => { disposed = true; cleanups.forEach((fn) => fn()); };
	}, [apply, refresh]);

	return {
		pet: snapshot?.pet ?? null,
		/** Active species definition when it has custom (ASCII) art. */
		species: snapshot?.species ?? null,
		loaded: snapshot !== undefined,
		floating,
		catalog,
		actions,
		error,
		refresh,
		act,
	};
}

export type PetState = ReturnType<typeof usePet>;

/** Desktop window commands for the floating pet. */
export async function invokePetWindow(command: "toggle_pet_window" | "dock_pet_window" | "close_pet_window" | "open_pet_settings"): Promise<void> {
	if (!isTauri()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke(command);
}
