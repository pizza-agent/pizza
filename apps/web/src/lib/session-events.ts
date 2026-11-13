export interface ChatSessionIdentity {
	sessionId?: string;
	threadId?: string;
}

interface SessionEvent {
	type: string;
	session_id?: string;
	thread_id?: string;
	payload?: unknown;
}

export function chatEventMatchesSession(event: SessionEvent, current: ChatSessionIdentity): boolean {
	const p = event.payload as Record<string, unknown> | undefined;
	const payloadSessionId = typeof p?.sessionId === "string" ? p.sessionId : undefined;
	return Boolean(
		(event.session_id && event.session_id === current.sessionId) ||
		(payloadSessionId && payloadSessionId === current.sessionId) ||
		(!event.session_id && event.thread_id && event.thread_id === current.threadId) ||
		(!event.session_id && !event.thread_id && event.type !== "SCHEDULED_TASK_FIRED"),
	);
}

/** Resolve navigation before the next get_state response (or React render). */
export function chatSessionTransition(event: SessionEvent, current: ChatSessionIdentity) {
	const p = event.payload as Record<string, unknown> | undefined;
	if (!p) return undefined;
	const string = (key: string) => typeof p[key] === "string" ? p[key] as string : undefined;
	let sessionId: string | undefined;
	let preserveHistory = false;
	switch (event.type) {
		case "SESSION_CREATED":
			if (p.created_by === "schedule") return undefined;
			sessionId = string("session_id");
			preserveHistory = !!string("context_parent_session_id");
			if (preserveHistory && string("context_parent_session_id") !== current.sessionId) return undefined;
			break;
		case "SESSION_FORKED":
		case "SESSION_BOUNDARY_INFERRED":
			sessionId = string("new_session_id");
			preserveHistory = event.type === "SESSION_BOUNDARY_INFERRED" || !!string("context_parent_session_id");
			break;
		case "SESSION_JUMPED":
			sessionId = string("reopened_as") ?? string("target_session_id");
			if (p.background === true) {
				// Scheduler hops must not redirect the visible conversation. Only
				// an internal continuation of the displayed session follows it.
				if (!string("context_parent_session_id") || string("context_parent_session_id") !== current.sessionId) return undefined;
				preserveHistory = true;
			}
			break;
		default:
			return undefined;
	}
	if (!sessionId) return undefined;
	return { sessionId, threadId: event.thread_id ?? current.threadId, preserveHistory };
}
