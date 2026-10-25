/**
 * Feed a session's agent activity into the app pet: busy while a turn runs,
 * XP and a celebration when it lands, a sad face on tool errors, sleepy after
 * compaction. Plugin contributions of the session's extensions join the
 * catalog for as long as the session lives.
 */

import type { EventBase } from "../event-store/types.js";
import { petService, type PetContributionSource } from "./service.js";

export interface PetEventSource {
	subscribe(handler: (event: EventBase) => void): () => void;
}

export function attachPetToSession(events: PetEventSource, contributions?: PetContributionSource): () => void {
	const session = Symbol("pet-session");
	const removeContributions = contributions ? petService.addContributionSource(contributions) : undefined;
	const unsubscribe = events.subscribe((event) => {
		switch (event.type) {
			case "AGENT_TURN_START":
				petService.setBusy(session, true);
				break;
			case "AGENT_TURN_END":
				petService.dispatch("turn_end");
				break;
			case "TOOL_EXECUTION_END":
				if ((event.payload as { is_error?: boolean } | undefined)?.is_error) petService.dispatch("tool_error");
				break;
			case "COMPACTION_END":
				petService.dispatch("compaction");
				break;
			case "AGENT_TURN_COMPLETED":
				petService.setBusy(session, false);
				if ((event.payload as { reason?: string } | undefined)?.reason === "error") petService.dispatch("tool_error");
				break;
		}
	});
	return () => {
		unsubscribe();
		removeContributions?.();
		petService.setBusy(session, false);
	};
}
