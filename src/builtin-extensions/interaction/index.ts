import { initiativeState } from "../../core/interaction/initiative.js";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.js";
import type { InteractionAnswer, InteractionRecord } from "../../../packages/protocol/interaction.js";
import { createInteraction, listInteractions, answerInteraction } from "../../core/interaction/store.js";
import { listInteractionCapabilities } from "../../core/interaction/capabilities.js";

export const INTERACTION_EXTENSION_ID = "interaction";
const HELP = `_interact capabilities — discover live registered capabilities and their IDs.
_interact initiative — inspect the main-agent suggestion allowance (read-only; always enabled in main).
Mark unsolicited suggestions with initiative:true; they require main-agent policy approval and must allow skipping.
_interact list — inspect cards in this conversation.
_interact show <<'JSON'
{"title":"Your question","fields":[{"id":"answer","type":"text","label":"Question","required":false}],"allowSkip":true}
JSON
The GUI presents single-select questions and action-only cards as one-click choice rows and supplies an Other/free-text entry automatically; do not add a generic Other option yourself. Completed cards show only the selected answer.
Cards support text/select/multi fields (options are {id,label,description?}) and actions ({id,label,capabilityId?}). Questions, labels and choices are supplied at runtime; no predefined onboarding flow exists. Maximum 6 fields and 8 actions. Cards are persisted in conversation history. In the GUI creation returns immediately: wait for a user reply before continuing dependent work; never retry or answer a card yourself. Users may answer in chat or skip. An action only selects an intent; it does not silently execute tools. Discover capability IDs before referencing them. Do not ask for passwords, tokens or client secrets. Do not put shell scripts, HTML or arbitrary links in cards.`;
function scope(ctx: ExtensionContext) {
	const store = ctx.sessionManager.eventStore,
		descriptor = ctx.sessionManager.projection?.getDescriptor();
	if (!store || !descriptor) throw Error("Interactions require an event-backed session");
	return { store, threadId: descriptor.thread_id };
}
async function terminalAnswer(
	record: InteractionRecord,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<InteractionAnswer | undefined> {
	const values: Record<string, string | string[]> = {};
	for (const field of record.card.fields ?? []) {
		const title = `${record.card.title} — ${field.label}${field.description ? `\n${field.description}` : ""}`;
		if (field.type === "select") {
			const options = (field.options ?? []).map((o) => `${o.id}: ${o.label}`);
			const choice = await ctx.ui.select(title, options, { signal });
			if (choice === undefined) return record.card.allowSkip === false ? undefined : { kind: "skip" };
			values[field.id] = field.options![options.indexOf(choice)].id;
		} else {
			const prompt =
				field.type === "multi"
					? `Choose IDs separated by commas: ${field.options?.map((o) => `${o.id}: ${o.label}`).join("; ")}`
					: field.placeholder;
			const value = await ctx.ui.input(title, prompt, { signal });
			if (value === undefined) return record.card.allowSkip === false ? undefined : { kind: "skip" };
			values[field.id] =
				field.type === "multi"
					? value
							.split(",")
							.map((v) => v.trim())
							.filter(Boolean)
					: value;
		}
	}
	let actionId: string | undefined;
	if (record.card.actions?.length) {
		const options = record.card.actions.map((a) => `${a.id}: ${a.label}`);
		const selected = await ctx.ui.select(record.card.title, options, { signal });
		if (selected === undefined) return record.card.allowSkip === false ? undefined : { kind: "skip" };
		actionId = record.card.actions[options.indexOf(selected)].id;
	}
	return { kind: "submit", values, ...(actionId ? { actionId } : {}) };
}
export const createInteractionExtension: ExtensionFactory = (pizza) => {
	pizza.registerBuiltinCommand({
		name: "_interact",
		description: "Ask dynamic questions or offer capability actions as persistent, skippable conversation cards.",
		help: HELP,
		parseArguments(args, heredoc) {
			return { op: args[0] ?? "help", input: heredoc ?? args[1] };
		},
		async execute(toolCallId, params, signal, _update, ctx) {
			if (["help", "-h", "--help"].includes(String(params.op)))
				return { content: [{ type: "text", text: HELP }], details: undefined };
			const { store, threadId } = scope(ctx);
			let data: unknown;
			if (params.op === "initiative") {
				if (params.input) throw Error("Initiative is always enabled in the main agent; this command is read-only");
				data=initiativeState(store);
			}
			else if (params.op === "capabilities") data = listInteractionCapabilities(store);
			else if (params.op === "list") data = listInteractions(store, threadId);
			else if (params.op === "show") {
				if (typeof params.input !== "string")
					throw Error("Provide a card JSON object with a heredoc; see _interact --help");
				let record = createInteraction(store, threadId, toolCallId, JSON.parse(params.input));
				if (ctx.ui.surface === "tui" && record.status === "pending") {
					const answer = await terminalAnswer(record, ctx, signal);
					if (answer) record = answerInteraction(store, threadId, record.id, answer).record;
				}
				data = {
					interaction: record,
					message:
						record.status === "pending"
							? "Card is ready. Wait for the user's reply; do not repeat this request or continue dependent actions."
							: "Use the user's answer to continue.",
				};
			} else throw Error("Unknown interaction operation; use _interact --help");
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
		},
	});
	// Natural-language answers remain ordinary user messages; only mark the pending card resolved.
	pizza.on("input", (event, ctx) => {
		if (!ctx.sessionManager?.eventStore || !ctx.sessionManager.projection) return;
		if (!["interactive", "rpc"].includes(event.source) || event.text.startsWith("/")) return;
		const { store, threadId } = scope(ctx);
		const pending = listInteractions(store, threadId).filter((r) => r.status === "pending");
		if (pending.length === 1 && event.text.trim())
			answerInteraction(store, threadId, pending[0].id, { kind: "text", text: event.text.slice(0, 8000) });
	});
};
