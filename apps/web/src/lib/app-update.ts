import { useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { installAppUpdate, onAppUpdateProgress, type AppUpdateProgress } from "./transport";

/**
 * Shared in-app update state so every update control (top banner, Settings ›
 * About) reflects the same download/install run.
 */
export type AppUpdateState =
	| { status: "idle" }
	| { status: "running"; progress: AppUpdateProgress | null }
	| { status: "error"; error: string };

let state: AppUpdateState = { status: "idle" };
const listeners = new Set<() => void>();
let disposeProgress: (() => void) | null = null;

function setState(next: AppUpdateState) {
	state = next;
	for (const l of listeners) l();
}

/** Kick off download → wait for busy agents → install → relaunch. */
export async function startAppUpdate(): Promise<void> {
	if (state.status === "running") return;
	setState({ status: "running", progress: null });
	disposeProgress ??= onAppUpdateProgress((progress) => {
		if (state.status === "running") setState({ status: "running", progress });
	});
	try {
		await installAppUpdate();
	} catch (e) {
		setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useAppUpdate(): AppUpdateState {
	return useSyncExternalStore(subscribe, () => state);
}

/** Button label for a running update, or null when nothing is running. */
export function appUpdateProgressLabel(t: TFunction, update: AppUpdateState): string | null {
	if (update.status !== "running") return null;
	const p = update.progress;
	if (p?.phase === "waitingForAgents") return t("update.waitingForAgents", { count: p.busy });
	if (p?.phase === "installing") return t("update.installing");
	if (p?.phase === "downloading" && p.total) {
		return t("update.downloadingPercent", { percent: Math.min(100, Math.floor((p.downloaded / p.total) * 100)) });
	}
	return t("update.downloading");
}
