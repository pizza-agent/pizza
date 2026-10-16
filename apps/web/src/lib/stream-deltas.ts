export interface StreamingItem {
	id: string;
	text: string;
	thinking?: string;
	streaming?: boolean;
}

type Delta = { text: string; thinking: string };

/** One persistent timer per workspace; flushed reducers are safe for React to replay. */
export class StreamDeltaBuffer<T extends StreamingItem> {
	private scopes = new Map<string, { deltas: Map<string, Delta>; timer: ReturnType<typeof setTimeout> }>();

	constructor(private apply: (scope: string, update: (items: T[]) => T[]) => void) {}

	queue(scope: string, id: string, kind: keyof Delta, text: string): void {
		let pending = this.scopes.get(scope);
		if (!pending) {
			pending = { deltas: new Map(), timer: setTimeout(() => this.flush(scope), 33) };
			this.scopes.set(scope, pending);
		}
		const delta = pending.deltas.get(id) ?? { text: "", thinking: "" };
		delta[kind] += text;
		pending.deltas.set(id, delta);
	}

	flush(scope: string): void {
		const pending = this.scopes.get(scope);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.scopes.delete(scope);
		// Detach the entire batch before scheduling state. Never consume it in
		// the updater: React may execute the updater more than once.
		const batch = pending.deltas;
		this.apply(scope, (items) => items.map((item) => {
			const delta = batch.get(item.id);
			if (!delta || !item.streaming) return item;
			return { ...item, text: item.text + delta.text, thinking: (item.thinking ?? "") + delta.thinking };
		}));
	}

	discard(scope: string): void {
		const pending = this.scopes.get(scope);
		if (pending) clearTimeout(pending.timer);
		this.scopes.delete(scope);
	}

	clear(): void {
		for (const scope of this.scopes.keys()) this.discard(scope);
	}
}
