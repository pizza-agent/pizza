import { interactionProjection } from "./projection.js";
import { assertInitiativeAllowed, isProactiveCard } from "./initiative.js";
import { isDeepStrictEqual } from "node:util";
import type { InteractionAnswer, InteractionCard, InteractionRecord } from "../../../packages/protocol/interaction.js";
import type { EventStore } from "../event-store/store.js";
import { interactionCardSchema, validateInteractionAnswer } from "./schema.js";
import { listInteractionCapabilities } from "./capabilities.js";

export function listInteractions(store: EventStore, threadId: string, now = Date.now()): InteractionRecord[] {
	const projection = interactionProjection(store);
	return [...projection.records.values()]
		.filter((entry) => entry.threadId === threadId)
		.map(({ record }) =>
			structuredClone({
				...record,
				...(projection.pendingDelivery.has(record.id)
					? { delivery: projection.delivered.has(record.id) ? ("delivered" as const) : ("pending" as const) }
					: {}),
				status: record.status === "pending" && record.expiresAt <= now ? "expired" : record.status,
			}),
		);
}
export function createInteraction(
	store: EventStore,
	threadId: string,
	toolCallId: string,
	input: unknown,
): InteractionRecord {
	const card = interactionCardSchema.parse(input);
	if (isProactiveCard(store, threadId)) card.initiative = true;
	const records = listInteractions(store, threadId);
	const existing = records.find((r) => r.toolCallId === toolCallId);
	if (existing) return existing;
	if (records.some((r) => r.status === "pending"))
		throw Error("An interaction is already pending. Wait for the user's answer; do not issue duplicate cards.");
	if (card.initiative) {
		assertInitiativeAllowed(store);
		if (card.allowSkip === false) throw Error("Proactive cards must allow skipping");
	}
	const available = listInteractionCapabilities(store);
	const capabilities = (card.actions ?? [])
		.filter((a) => a.capabilityId)
		.map((a) => {
			const capability = available.find((c) => c.id === a.capabilityId);
			if (!capability) throw Error(`Unknown capability: ${a.capabilityId}. Discover _interact capabilities first.`);
			return capability;
		});
	const event = store.append({
		type: "INTERACTION_REQUESTED",
		actor_id: "agent",
		thread_id: threadId,
		payload: { card, toolCallId, capabilities, expiresAt: Date.now() + card.expiresInMinutes * 60000 },
	});
	return listInteractions(store, threadId).find((r) => r.id === event.event_id)!;
}
export function answerInteraction(
	store: EventStore,
	threadId: string,
	requestId: string,
	input: unknown,
	options?: { deliveryRequired?: boolean },
): { record: InteractionRecord; duplicate: boolean } {
	const record = listInteractions(store, threadId).find((r) => r.id === requestId);
	if (!record) throw Error("Interaction is not in this conversation");
	const answer = validateInteractionAnswer(record.card, input);
	if (record.answer) {
		if (isDeepStrictEqual(record.answer, answer)) return { record, duplicate: true };
		throw Error("This interaction was already answered");
	}
	if (record.status !== "pending") throw Error("This interaction has expired");
	store.append({
		type: "INTERACTION_ANSWERED",
		actor_id: "user",
		thread_id: threadId,
		caused_by: requestId,
		payload: { requestId, answer, ...(options?.deliveryRequired ? { deliveryRequired: true } : {}) },
	});
	return { record: listInteractions(store, threadId).find((r) => r.id === requestId)!, duplicate: false };
}
export function interactionReplyMessage(record: InteractionRecord): string {
	const answer = record.answer;
	const action = answer?.kind === "submit" ? record.card.actions?.find((a) => a.id === answer.actionId) : undefined;
	const capability = action?.capabilityId ? record.capabilities.find((c) => c.id === action.capabilityId) : undefined;
	const lines = [record.card.title];
	if (answer?.kind === "text") lines.push(answer.text);
	else if (answer?.kind === "skip") lines.push("Skipped / 已跳过");
	else if (answer?.kind === "submit") {
		for (const f of record.card.fields ?? []) {
			const value = answer.values[f.id];
			if (value !== undefined) {
				const labels = (Array.isArray(value) ? value : [value]).map(
					(v) => f.options?.find((o) => o.id === v)?.label ?? v,
				);
				lines.push(`${f.label}: ${labels.join(", ")}`);
			}
		}
		if (action) lines.push(action.label);
	}
	return (
		"[interaction_response]\n" +
		JSON.stringify({
			requestId: record.id,
			title: record.card.title,
			answer,
			display: lines.join("\n"),
			...(capability ? { selectedCapability: capability } : {}),
			guidance:
				"These are the user's answers. A free-text reply may change the topic or decline the question; do not invent profile facts. Execute only the selected intent using the registered tools. Skipping grants no permission. Persist user preferences separately from assistant identity.",
		})
	);
}
