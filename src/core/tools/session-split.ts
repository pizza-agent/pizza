import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

const sessionSplitSchema = Type.Object({
	reason: Type.Optional(
		Type.String({
			description:
				"Short reason for the split (e.g. 'topic_change', 'new_task', 'context_reset'). Helps the user understand why the session was divided.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "Optional name for the new session (e.g. 'Fix authentication bug'). If omitted, a default name is used.",
		}),
	),
});

export type SessionSplitToolInput = Static<typeof sessionSplitSchema>;

export function createSessionSplitToolDefinition(): ToolDefinition<typeof sessionSplitSchema, undefined> {
	return defineTool({
		name: "session_split",
		executionMode: "sequential",
		label: "session_split",
		description:
			"Split the current conversation session, starting a new session from this point forward. " +
			"Previous messages will no longer be included in the LLM context for subsequent turns. " +
			"Prefer to split EARLY and DECISIVELY whenever the user moves to a new task, a different file or area, " +
			"or a fresh question unrelated to the current work — keeping stale context wastes tokens and degrades answers. " +
			"Concrete signals to split: a brand-new request, switching to a different bug/feature/component, " +
			"'also...', 'next...', or 'now do...' pivots, or any ask whose prior context no longer helps. " +
			"Do NOT split for follow-ups, clarifications, or refinements of the SAME task in progress. " +
			"You can call this alongside other tools in the same turn. " +
			"IMPORTANT: Call this AT MOST ONCE per turn. After the split, your context will be refreshed " +
			"to the new session — proceed directly with the user's requested task.",
		promptSnippet: "Split the conversation session when the user shifts to a new topic",
		promptGuidelines: [
			"Prefer to _session_split promptly when the user starts a new task or a clearly different topic — err on the side of splitting when the previous context is no longer useful.",
			"Only skip the split when the new message is a follow-up, clarification, or refinement of the SAME task in progress.",
			"Call _session_split at most once per turn. After the split, your context is refreshed — proceed with the task.",
		],
		parameters: sessionSplitSchema,
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = ctx?.sessionManager?.splitSession?.(
				params.reason ?? "intent_shift",
				params.name,
			);

			if (!result) {
				throw new Error("Session split is not available in this runtime configuration.");
			}

			if (result.already_split) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The session was already split for this turn. Do NOT call _session_split again — " +
								"proceed directly with the user's requested task.",
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Session split successfully. New session: ${result.session_id}. ` +
							"Your context has been refreshed to the new session. " +
							"Proceed with the user's task now — do NOT call _session_split again.",
					},
				],
			};
		},
		renderCall(args, _theme) {
			const reason = args?.reason ?? "intent_shift";
			const name = args?.name ? ` → ${args.name}` : "";
			return new Text(`session_split (${reason})${name}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content
				.map((c) => ("text" in c ? c.text : ""))
				.join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}
