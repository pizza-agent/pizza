import type { EventStore } from "../event-store/store.js";
import type { SessionFacade } from "../session/session-facade.js";
import { interactionProjection } from "./projection.js";
import { interactionReplyMessage } from "./store.js";

/** Durable answers are the outbox; USER_MESSAGE acceptance is the delivery receipt. */
export class InteractionDelivery {
	private inFlight = new Set<string>();
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribe: () => void;
	constructor(
		private store: EventStore,
		private facade: SessionFacade,
		private onError: (error: unknown) => void,
	) {
		this.unsubscribe = store.subscribe((e) => {
			if (["AGENT_TURN_END", "SESSION_CREATED", "SESSION_JUMPED", "SESSION_FORKED"].includes(e.type)) this.schedule();
		});
		facade.addDisposer?.(() => this.dispose());
	}
	private schedule() {
		if (!this.disposed && !this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.resume();
			}, 100);
			this.timer.unref?.();
		}
	}
	resume() {
		if (this.disposed) return;
		const threadId = this.facade.runtime.getProjection().getDescriptor().thread_id;
		const projection = interactionProjection(this.store);
		for (const [id, entry] of projection.records) {
			if (
				entry.threadId !== threadId ||
				!projection.pendingDelivery.has(id) ||
				projection.delivered.has(id) ||
				this.inFlight.has(id)
			)
				continue;
			if (this.facade.isRunning) {
				this.schedule();
				return;
			}
			this.inFlight.add(id);
			// A single active thread receives answers serially; never switch the UI's thread to deliver.
			void this.facade
				.prompt(interactionReplyMessage(entry.record), undefined, undefined, { source: "interaction", threadId })
				.then(() => {
					this.inFlight.delete(id);
					if (this.disposed) return;
					if (interactionProjection(this.store).delivered.has(id)) this.resume();
					else this.onError(Error("Interaction was not accepted; retry delivery"));
				})
				.catch((error) => {
					this.inFlight.delete(id);
					if (!this.disposed) this.onError(error);
				});
			return;
		}
	}
	dispose() {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.unsubscribe();
	}
}
