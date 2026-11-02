import type { InteractionAnswer, InteractionCard, InteractionRecord } from "@tomsun28/pizza-protocol";
export interface InteractionChoice {
	id: string;
	label: string;
	description?: string;
	mark: string;
	answer: InteractionAnswer;
}
export function choiceMark(index: number): string {
	return String.fromCharCode(65 + index);
}
/** Only a complete single choice may submit immediately; forms retain explicit submission. */
export function quickChoices(card: InteractionCard): InteractionChoice[] | undefined {
	const fields = card.fields ?? [],
		actions = card.actions ?? [];
	if (fields.length === 0 && actions.length)
		return actions.map((a, i) => ({
			...a,
			mark: choiceMark(i),
			answer: { kind: "submit", values: {}, actionId: a.id },
		}));
	if (fields.length !== 1 || fields[0].type !== "select" || actions.length) return;
	const field = fields[0];
	return field.options?.map((o, i) => ({
		...o,
		mark: choiceMark(i),
		answer: { kind: "submit", values: { [field.id]: o.id } },
	}));
}
export function answeredRows(record: InteractionRecord): { label?: string; text: string; mark?: string }[] {
	const answer = record.answer;
	if (!answer || answer.kind === "skip") return [];
	if (answer.kind === "text") {
		const choices = quickChoices(record.card);
		return [
			{
				text: answer.text,
				mark: choices ? choiceMark(choices.length) : undefined,
			},
		];
	}
	const rows: { label?: string; text: string; mark?: string }[] = [];
	for (const field of record.card.fields ?? []) {
		const value = answer.values[field.id];
		for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
			if (!v.trim()) continue;
			const index = field.options?.findIndex((o) => o.id === v) ?? -1;
			rows.push({
				label: field.label,
				text: index >= 0 ? field.options![index].label : v,
				mark: index >= 0 ? choiceMark(index) : undefined,
			});
		}
	}
	const actionIndex = record.card.actions?.findIndex((a) => a.id === answer.actionId) ?? -1;
	if (actionIndex >= 0) rows.push({ text: record.card.actions![actionIndex].label, mark: choiceMark(actionIndex) });
	return rows;
}
export function interactionResponseId(text: string): string | undefined {
	if (!text.startsWith("[interaction_response]\n")) return;
	try {
		const value = JSON.parse(text.slice("[interaction_response]\n".length));
		return typeof value.requestId === "string" &&
			typeof value.display === "string" &&
			["submit", "text", "skip"].includes(value.answer?.kind)
			? value.requestId
			: undefined;
	} catch {
		return;
	}
}
