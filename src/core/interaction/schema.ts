import { z } from "zod";
import type { InteractionAnswer, InteractionCard } from "../../../packages/protocol/interaction.js";
const id = z
	.string()
	.min(1)
	.max(80)
	.regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/)
	.refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const text = z.string().trim().min(1).max(200);
const option = z.object({ id, label: text, description: z.string().max(1000).optional() }).strict();
export const interactionCardSchema = z
	.object({
		initiative: z.boolean().optional(),
		title: text,
		description: z.string().max(4000).optional(),
		fields: z
			.array(
				z
					.object({
						id,
						type: z.enum(["text", "select", "multi"]),
						label: text,
						description: z.string().max(1000).optional(),
						placeholder: z.string().max(200).optional(),
						required: z.boolean().optional(),
						options: z.array(option).min(1).max(24).optional(),
					})
					.strict(),
			)
			.max(6)
			.optional(),
		actions: z
			.array(z.object({ id, label: text, capabilityId: z.string().min(1).max(300).optional() }).strict())
			.max(8)
			.optional(),
		allowSkip: z.boolean().default(true),
		submitLabel: text.optional(),
		expiresInMinutes: z.number().int().min(1).max(10080).default(1440),
	})
	.strict()
	.superRefine((card, ctx) => {
		if (!card.fields?.length && !card.actions?.length)
			ctx.addIssue({ code: "custom", message: "Provide at least one field or action" });
		for (const group of [card.fields ?? [], card.actions ?? []])
			if (new Set(group.map((v) => v.id)).size !== group.length)
				ctx.addIssue({ code: "custom", message: "IDs must be unique" });
		for (const field of card.fields ?? []) {
			if (field.type !== "text" && !field.options?.length)
				ctx.addIssue({ code: "custom", message: `${field.id} requires options` });
			if (field.options && new Set(field.options.map((o) => o.id)).size !== field.options.length)
				ctx.addIssue({ code: "custom", message: "Option IDs must be unique" });
		}
	});
const answerSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("submit"),
			values: z.record(id, z.union([z.string().max(8000), z.array(z.string().max(80)).max(24)])),
			actionId: id.optional(),
		})
		.strict(),
	z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(8000) }).strict(),
	z.object({ kind: z.literal("skip") }).strict(),
]);
export function validateInteractionAnswer(card: InteractionCard, input: unknown): InteractionAnswer {
	const answer = answerSchema.parse(input);
	if (answer.kind === "skip") {
		if (card.allowSkip === false) throw Error("This card cannot be skipped");
		return answer;
	}
	if (answer.kind === "text") return answer;
	const fields = card.fields ?? [];
	if (Object.keys(answer.values).some((key) => !fields.some((f) => f.id === key))) throw Error("Unknown answer field");
	if (answer.actionId && !card.actions?.some((a) => a.id === answer.actionId)) throw Error("Unknown action");
	for (const f of fields) {
		const v = answer.values[f.id];
		if (v === undefined) {
			if (f.required) throw Error(`${f.label} is required`);
			continue;
		}
		if (f.type === "multi") {
			if (!Array.isArray(v) || new Set(v).size !== v.length || v.some((x) => !f.options?.some((o) => o.id === x)))
				throw Error(`Invalid choices for ${f.label}`);
			if (f.required && !v.length) throw Error(`${f.label} is required`);
		} else {
			if (typeof v !== "string" || (f.required && !v.trim())) throw Error(`Invalid answer for ${f.label}`);
			if (f.type === "select" && v && !f.options?.some((o) => o.id === v)) throw Error(`Invalid choice for ${f.label}`);
		}
	}
	return answer;
}
