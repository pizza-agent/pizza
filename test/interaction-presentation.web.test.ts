import { describe, it, expect } from "vitest";
import { quickChoices, answeredRows, interactionResponseId } from "../apps/web/src/lib/interaction-presentation";
import type { InteractionRecord } from "../packages/protocol/interaction";
const card = {
	title: "接下来想先做哪件？",
	fields: [
		{
			id: "next",
			type: "select" as const,
			label: "接下来想先做哪件？",
			options: [
				{ id: "intro", label: "先讲讲项目现状" },
				{ id: "change", label: "有具体改动要做" },
				{ id: "sync", label: "先同步代码" },
			],
		},
	],
};
const record: InteractionRecord = {
	id: "r",
	toolCallId: "t",
	card,
	createdAt: 0,
	expiresAt: 100,
	status: "answered",
	capabilities: [],
	answer: { kind: "submit", values: { next: "change" } },
};
describe("interaction choice presentation", () => {
	it("submits the complete single-select answer in one click and preserves original option letters", () => {
		const choices = quickChoices(card)!;
		expect(choices.map((c) => c.mark)).toEqual(["A", "B", "C"]);
		expect(choices[1].answer).toEqual({ kind: "submit", values: { next: "change" } });
		expect(answeredRows(record)).toEqual([{ label: card.fields[0].label, text: "有具体改动要做", mark: "B" }]);
	});
	it("does not auto-submit a partial form or multiple-choice selection", () => {
		expect(
			quickChoices({ ...card, fields: [...card.fields, { id: "name", type: "text", label: "Name" }] }),
		).toBeUndefined();
		expect(quickChoices({ ...card, fields: [{ ...card.fields[0], type: "multi" }] })).toBeUndefined();
		expect(quickChoices({ ...card, actions: [{ id: "connect", label: "Connect" }] })).toBeUndefined();
	});
	it("supports dynamic capability actions and collapses to the chosen action", () => {
		const actions = {
			title: "连接什么？",
			actions: [
				{ id: "mail", label: "邮箱", capabilityId: "mcp:mail" },
				{ id: "calendar", label: "日历", capabilityId: "custom:calendar" },
			],
		};
		expect(quickChoices(actions)![1].answer).toEqual({ kind: "submit", values: {}, actionId: "calendar" });
		expect(
			answeredRows({ ...record, card: actions, answer: { kind: "submit", values: {}, actionId: "calendar" } }),
		).toEqual([{ text: "日历", mark: "B" }]);
	});
	it("shows custom input in the Other position and skips unselected options and blank fields", () => {
		expect(answeredRows({ ...record, answer: { kind: "text", text: "先看测试" } })).toEqual([
			{ text: "先看测试", mark: "D" },
		]);
		expect(answeredRows({ ...record, answer: { kind: "skip" } })).toEqual([]);
		expect(
			answeredRows({
				...record,
				card: { title: "Profile", fields: [{ id: "name", type: "text", label: "Name" }] },
				answer: { kind: "submit", values: { name: "" } },
			}),
		).toEqual([]);
	});
	it("only identifies valid structured replies; ordinary or malformed input stays ordinary", () => {
		expect(interactionResponseId("hello")).toBeUndefined();
		expect(interactionResponseId("[interaction_response]\ninvalid")).toBeUndefined();
		expect(
			interactionResponseId(
				'[interaction_response]\n{"requestId":"r","display":"Answer","answer":{"kind":"text","text":"Answer"}}',
			),
		).toBe("r");
	});
});
