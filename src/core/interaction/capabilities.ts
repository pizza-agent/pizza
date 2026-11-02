import type { InteractionCapability } from "../../../packages/protocol/interaction.js";
import type { EventStore } from "../event-store/store.js";
const registry = new WeakMap<EventStore, Map<string, () => InteractionCapability[]>>();
/** Register a live provider per runtime store. Any extension can contribute capabilities. */
export function registerInteractionCapabilities(
	store: EventStore,
	source: string,
	provider: () => InteractionCapability[],
): () => void {
	let entries = registry.get(store);
	if (!entries) {
		entries = new Map();
		registry.set(store, entries);
	}
	entries.set(source, provider);
	return () => {
		if (entries.get(source) === provider) entries.delete(source);
	};
}
export function listInteractionCapabilities(store: EventStore): InteractionCapability[] {
	const result = new Map<string, InteractionCapability>();
	for (const provider of registry.get(store)?.values() ?? [])
		for (const value of provider()) {
			if (result.has(value.id)) throw Error(`Duplicate interaction capability: ${value.id}`);
			result.set(value.id, { ...value });
		}
	return [...result.values()];
}
