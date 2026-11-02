import type { EventStore } from "../event-store/store.js";
import type { InteractionRecord, InteractionAnswer, InteractionCard } from "../../../packages/protocol/interaction.js";
/** Incremental read model; WeakMap ownership follows the runtime store lifetime. */
const projections = new WeakMap<EventStore, InteractionProjection>();
class InteractionProjection {
	sequence = 0;
	records = new Map<string, { threadId?: string; record: InteractionRecord }>();
	lastSuggestionAt?: number;
	pendingDelivery = new Set<string>();
	delivered = new Set<string>();
	refresh(store: EventStore) {
		// Read up to a captured watermark so a later asynchronous append is never skipped.
		const head = store.head_sequence;
		if (head === this.sequence) return;
		for (const e of store.query({
			types: ["INTERACTION_REQUESTED", "INTERACTION_ANSWERED", "USER_MESSAGE"],
			after_sequence: this.sequence,
			before_sequence: head + 1,
		})) {
			if (e.type === "INTERACTION_REQUESTED") {
				const p = e.payload as {
					card: InteractionCard;
					toolCallId: string;
					expiresAt: number;
					capabilities: InteractionRecord["capabilities"];
				};
				this.records.set(e.event_id, {
					threadId: e.thread_id,
					record: {
						id: e.event_id,
						toolCallId: p.toolCallId,
						card: p.card,
						createdAt: e.timestamp,
						expiresAt: p.expiresAt,
						capabilities: p.capabilities ?? [],
						status: "pending",
					},
				});
				if (p.card.initiative) this.lastSuggestionAt = e.timestamp;
			} else if (e.type === "INTERACTION_ANSWERED") {
				const p = e.payload as { requestId: string; answer: InteractionAnswer; deliveryRequired?: boolean };
				if (p.deliveryRequired) this.pendingDelivery.add(p.requestId);
				const entry = this.records.get(p.requestId);
				if (entry && entry.threadId === e.thread_id)
					entry.record = {
						...entry.record,
						answer: p.answer,
						status: p.answer.kind === "skip" ? "skipped" : "answered",
					};
			} else {
				const text = (e.payload as { content?: unknown }).content;
				if (typeof text === "string" && text.startsWith("[interaction_response]\n")) {
					try {
						const id = JSON.parse(text.slice("[interaction_response]\n".length)).requestId;
						const entry = this.records.get(id);
						if (entry?.threadId === e.thread_id) this.delivered.add(id);
					} catch {
						/* Ordinary user text may share the prefix. */
					}
				}
			}
		}
		this.sequence = head;
	}
}
export function interactionProjection(store: EventStore) {
	let projection = projections.get(store);
	if (!projection) {
		projection = new InteractionProjection();
		projections.set(store, projection);
	}
	projection.refresh(store);
	return projection;
}
