import { interactionProjection } from "./projection.js";
import type { EventStore } from "../event-store/store.js";

const mainStores = new WeakSet<EventStore>();
const requestedForms = new WeakMap<EventStore, Map<string, boolean>>();
/** Trusted caller metadata, never a field supplied by the model. */
export function setInteractionOrigin(store: EventStore, threadId: string, requested: boolean): void {
	let threads = requestedForms.get(store);
	if (!threads) {
		threads = new Map();
		requestedForms.set(store, threads);
	}
	threads.set(threadId, requested);
}
export function isProactiveCard(store: EventStore, threadId: string): boolean {
	return mainStores.has(store) && requestedForms.get(store)?.get(threadId) !== true;
}
export function enableMainInitiative(store: EventStore): void {
	mainStores.add(store);
}
export function initiativeState(store: EventStore, now = Date.now()) {
	const enabled = mainStores.has(store);
	const lastSuggestionAt = interactionProjection(store).lastSuggestionAt;
	return {
		enabled,
		lastSuggestionAt: lastSuggestionAt,
		canSuggest:
			mainStores.has(store) && enabled && (lastSuggestionAt === undefined || now - lastSuggestionAt >= 86400000),
	};
}
export function assertInitiativeAllowed(store: EventStore) {
	const state = initiativeState(store);
	if (!state.canSuggest)
		throw Error(
			"Proactive suggestions are unavailable or already shown in the last 24 hours. Continue the user's task without another suggestion.",
		);
}
export function initiativePrompt(store: EventStore): string {
	const state = initiativeState(store);
	return `\n[Main agent initiative — this workspace only]\n${JSON.stringify(state)}\nYou may offer one useful, contextual suggestion when canSuggest is true, only at a natural pause after helping with the current task. Main-agent cards count as proactive by default; only trusted user-requested form or interaction-response turns may bypass this. Model-supplied initiative:false grants no exemption. Use skippable cards. Read memories and _interact list first; avoid repeated questions, unresolved cards, filler greetings and unsolicited account scanning. Skipping ends this topic for the conversation; do not restate the suggestion in plain chat. All unsolicited suggestions count toward this limit, not just cards. Initiative is always enabled in the main agent; there is no on/off switch. User-requested forms and existing explicit reminders remain available.\nWhen a matter merits follow-up, offer a small dynamic card with later/time/decline choices. Only after the user's explicit choice, discover _cron --help and create one main-scope task with --max-runs 1 pinned to this conversation. Record the subject, agreed time, authorized read sources, completion condition and origin in its prompt. Never create workspace tasks or use _tell for proactive work. Do not treat account connection as permission for background reads. At check time, report only a meaningful change, a blocker or a decision; if nothing changed, finish without a message. Never send email or post content under connection permission. Do not retry a failed one-off check indefinitely. Offer _cron pause/delete for cancellation; respect a user declining a particular topic without treating that as a global switch. Never claim a follow-up exists until scheduler creation succeeds.\n`;
}
