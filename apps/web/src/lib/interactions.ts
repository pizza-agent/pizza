import { useCallback, useEffect, useRef, useState } from "react";
import type { InteractionAnswer, InteractionRecord } from "@tomsun28/pizza-protocol";
import { sendCommandAwait, subscribeEvents } from "./transport";
import { samePath } from "./platform";
export type { InteractionAnswer, InteractionRecord } from "@tomsun28/pizza-protocol";

/** Workspace/thread scoped state. Private answers stay in the backend event store, not browser storage. */
export function useInteractions(workspace: string | undefined | null, sessionId: string | undefined, enabled: boolean) {
	const [records, setRecords] = useState<InteractionRecord[]>([]);
	const generation = useRef(0),
		latest = useRef(0);
	const invalidate = useCallback(() => {
		generation.current++;
	}, []);
	const refresh = useCallback(async () => {
		if (!enabled || !workspace) return;
		const epoch = generation.current,
			request = ++latest.current;
		const result = await sendCommandAwait<InteractionRecord[]>({ type: "interaction_list" });
		if (epoch === generation.current && request === latest.current) setRecords(result.data ?? []);
	}, [enabled, workspace]);
	useEffect(() => {
		invalidate();
		setRecords([]);
		if (!enabled || !workspace) return;
		let disposed = false,
			un: (() => void) | undefined;
		const update = () => {
			void refresh().catch(() => {});
		};
		void subscribeEvents((event) => {
			if (
				!disposed &&
				(!event._cwd || samePath(String(event._cwd), workspace)) &&
				["INTERACTION_REQUESTED", "INTERACTION_ANSWERED"].includes(String(event.type))
			)
				update();
		}).then((fn) => {
			if (disposed) fn();
			else {
				un = fn;
				update();
			}
		});
		window.addEventListener("focus", update);
		return () => {
			disposed = true;
			invalidate();
			un?.();
			window.removeEventListener("focus", update);
		};
	}, [enabled, workspace, sessionId, refresh, invalidate]);
	const respond = useCallback(async (record: InteractionRecord, answer: InteractionAnswer) => {
		const epoch = generation.current;
		const result = await sendCommandAwait<{ record: InteractionRecord }>(
			{ type: "interaction_respond", requestId: record.id, answer },
			15000,
		);
		if (epoch === generation.current && result.data) {
			latest.current++;
			setRecords((old) => old.map((r) => (r.id === record.id ? result.data!.record : r)));
		}
	}, []);
	return { records, respond, refresh };
}
export function interactionResponseDisplay(text: string): string {
	if (!text.startsWith("[interaction_response]\n")) return text;
	try {
		const p = JSON.parse(text.slice("[interaction_response]\n".length));
		if (typeof p.display === "string") return p.display;
	} catch {
		/* Ordinary user text is never hidden on a parse failure. */
	}
	return text;
}
