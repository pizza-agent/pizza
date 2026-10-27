import { useCallback, useEffect, useRef, useState } from "react";
import type { MainAgentDocument, MainAgentProfile, MainJournalPage } from "@tomsun28/pizza-protocol";
import { sendCommandAwait } from "./transport";
import { samePath } from "./platform";
import { usePet } from "./pet";

export type { MainAgentDocument, MainAgentProfile, MainJournalPage, MainMemorySummary } from "@tomsun28/pizza-protocol";

export async function getMainDocument(sourceId: string): Promise<MainAgentDocument> {
	const result = await sendCommandAwait<MainAgentDocument>({ type: "main_document_read", sourceId });
	if (!result.data) throw new Error("Missing document response");
	return result.data;
}
export async function saveMainDocument(sourceId: string, content: string, expectedRevision: string): Promise<MainAgentDocument> {
	const result = await sendCommandAwait<MainAgentDocument>({ type: "main_document_write", sourceId, content, expectedRevision });
	if (!result.data) throw new Error("Missing saved document response");
	return result.data;
}
export async function getMainJournals(before?: string): Promise<MainJournalPage> {
	const result = await sendCommandAwait<MainJournalPage>({ type: "main_journal_list", before, limit: 20 });
	if (!result.data) throw new Error("Missing journal response");
	return result.data;
}

/** Scope responses to a workspace and refresh after turns or external edits. */
export function useMainAgentProfile(enabled: boolean, workspace: string | null | undefined, running: boolean, connected = true) {
	const [profile, setProfile] = useState<MainAgentProfile | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const pet = usePet(enabled);
	const generation = useRef(0);
	const scope = useRef({ enabled, workspace });
	scope.current = { enabled, workspace };
	const connection = useRef(connected);
	connection.current = connected;
	const refresh = useCallback(async () => {
		if (!enabled || !workspace || !connection.current || !scope.current.enabled || !samePath(scope.current.workspace, workspace)) return;
		const request = ++generation.current;
		setLoading(true);
		try {
			const result = await sendCommandAwait<MainAgentProfile>({ type: "main_profile" });
			if (!result.data) throw new Error("Missing agent profile response");
			if (request === generation.current) { setProfile(result.data); setError(""); }
		} catch (e) {
			if (request === generation.current) setError(e instanceof Error ? e.message : String(e));
		} finally { if (request === generation.current) setLoading(false); }
	}, [enabled, workspace]);
	useEffect(() => {
		setProfile(null); setError(""); setLoading(false);
		const currentGeneration = generation;
		return () => { currentGeneration.current++; };
	}, [refresh]);
	useEffect(() => { if (connected) void refresh(); }, [connected, refresh]);
	useEffect(() => {
		if (!enabled) return;
		const onFocus = () => { void refresh(); };
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [enabled, refresh]);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) void refresh();
		wasRunning.current = running;
	}, [running, refresh]);

	return { profile, loading, error, refresh, pet };
}

export type MainAgentProfileState = ReturnType<typeof useMainAgentProfile>;
