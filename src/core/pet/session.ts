/** Project actual session events into the companion's expression, independently of its artwork. */
import type { EventBase } from "../event-store/types.js";
import { petService, type PetContributionSource } from "./service.js";
import type { PetActivityMood } from "./sprites.js";

export interface PetEventSource {
	subscribe(handler: (event: EventBase) => void): () => void;
}

export function attachPetToSession(events: PetEventSource, contributions?: PetContributionSource): () => void {
	const session = Symbol("pet-session");
	const removeContributions = contributions ? petService.addContributionSource(contributions) : undefined;
	const approvals = new Set<string>();
	const interactions = new Map<string, ReturnType<typeof setTimeout>>();
	const tools = new Set<string>();
	let active = false;
	let phase: PetActivityMood = "thinking";
	const publish = () => petService.setActivity(session,
		approvals.size || interactions.size ? "waiting" : tools.size ? "working" : active ? phase : null);
	const clear = () => {
		active = false;
		approvals.clear();
		for (const timer of interactions.values()) clearTimeout(timer);
		interactions.clear();
		tools.clear();
	};
	const unsubscribe = events.subscribe((event) => {
		const payload = event.payload as {
			chunk?: { kind?: string }; requires_approval?: boolean; intent_event_id?: string;
			tool_call_id?: string; is_error?: boolean; reason?: string;
			requestId?: string; expiresAt?: number;
		} | undefined;
		switch (event.type) {
			case "AGENT_TURN_START":
			case "LLM_CALL_REQUESTED":
			case "AGENT_THINKING_START":
				active = true; phase = "thinking";
				break;
			case "AGENT_MESSAGE_CHUNK": {
				const kind = payload?.chunk?.kind;
				if (kind === "text_start" || kind === "text_delta") phase = "speaking";
				else if (kind === "thinking_start" || kind === "thinking_delta") phase = "thinking";
				else if (kind === "toolcall_start") phase = "working";
				else return;
				break;
			}
			case "AGENT_MESSAGE_END":
				phase = "thinking";
				break;
			case "INTENT_TOOL_CALL":
			case "INTENT_FILE_EDIT":
			case "INTENT_COMMAND_EXEC":
				if (payload?.requires_approval) approvals.add(event.event_id);
				break;
			case "USER_APPROVAL":
			case "USER_REJECTION":
				if (payload?.intent_event_id) approvals.delete(payload.intent_event_id);
				break;
			case "INTERACTION_REQUESTED":
				if (interactions.has(event.event_id)) clearTimeout(interactions.get(event.event_id));
				{
					const timer = setTimeout(() => { interactions.delete(event.event_id); publish(); },
						Math.min(2 ** 31 - 1, Math.max(0, (payload?.expiresAt ?? Date.now() + 30 * 60_000) - Date.now())));
					timer.unref?.();
					interactions.set(event.event_id, timer);
				}
				break;
			case "INTERACTION_ANSWERED":
				if (payload?.requestId) { clearTimeout(interactions.get(payload.requestId)); interactions.delete(payload.requestId); }
				break;
			case "TOOL_EXECUTION_START":
				// Session-scoped approval can bypass USER_APPROVAL for this intent.
				if (event.caused_by) approvals.delete(event.caused_by);
				if (payload?.tool_call_id) tools.add(payload.tool_call_id);
				phase = "working";
				break;
			case "TOOL_EXECUTION_END":
				// Rejections and hook failures can finish without ever starting a tool.
				if (event.caused_by) approvals.delete(event.caused_by);
				if (payload?.tool_call_id) tools.delete(payload.tool_call_id);
				phase = "thinking";
				if (payload?.is_error) petService.dispatch("tool_error");
				break;
			case "COMPACTION_START":
				phase = "thinking";
				break;
			case "COMPACTION_END":
				petService.dispatch("compaction");
				break;
			case "USER_INTERRUPT":
				clear(); petService.dispatch("turn_cancel");
				break;
			case "AGENT_TURN_COMPLETED":
				if (payload?.reason === "interaction_pending") { active = false; tools.clear(); }
				else {
					clear();
					petService.dispatch(payload?.reason === "error" || payload?.reason === "loop_detected" ? "tool_error" : payload?.reason === "aborted" ? "turn_cancel" : "turn_end");
				}
				break;
			case "AGENT_ERROR":
				clear(); petService.dispatch("tool_error");
				break;
			default: return;
		}
		publish();
	});
	return () => {
		unsubscribe();
		clear();
		removeContributions?.();
		petService.setActivity(session, null);
	};
}
