import { createPromptBuilder } from "../src/core/facade/prompt-builder.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import {
	enableMainInitiative,
	initiativeState,
	initiativePrompt,
} from "../src/core/interaction/initiative.js";
import { createInteraction, answerInteraction } from "../src/core/interaction/store.js";
const card = { title: "认识一下？", initiative: true, fields: [{ id: "name", type: "text", label: "称呼" }] };
describe("main agent initiative isolation", () => {
	let dir: string, main: SqliteEventStore, other: SqliteEventStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-initiative-"));
		main = new SqliteEventStore("main", join(dir, "main.sqlite"));
		other = new SqliteEventStore("project", join(dir, "project.sqlite"));
		enableMainInitiative(main);
	});
	afterEach(() => {
		vi.useRealTimers();
		main.close();
		other.close();
		rmSync(dir, { recursive: true, force: true });
	});
	it("gates initiative to explicitly registered main runtimes while preserving generic workspace cards", () => {
		expect(initiativeState(main).canSuggest).toBe(true);
		expect(initiativeState(other).canSuggest).toBe(false);
		expect(() => createInteraction(other, "a", "call", card)).toThrow("unavailable");
		expect(createInteraction(other, "a", "call", { ...card, initiative: false }).status).toBe("pending");
	});
	it("limits suggestions across main conversations and does not reset the limit on skip", () => {
		vi.useFakeTimers();
		const first = createInteraction(main, "a", "one", card);
		answerInteraction(main, "a", first.id, { kind: "skip" });
		expect(() => createInteraction(main, "b", "two", card)).toThrow("24 hours");
		vi.advanceTimersByTime(86400001);
		expect(createInteraction(main, "b", "three", card).status).toBe("pending");
		expect(other.query({ types: ["INTERACTION_REQUESTED"] })).toEqual([]);
	});
	it("ignores legacy off preferences and remains enabled after restart", () => {
		main.append({type:"CUSTOM_MESSAGE",actor_id:"user",payload:{kind:"main-initiative",data:{enabled:false}}});
		main.close();
		main = new SqliteEventStore("main", join(dir, "main.sqlite"));
		enableMainInitiative(main);
		expect(initiativeState(main).enabled).toBe(true);
		expect(initiativeState(main).canSuggest).toBe(true);
		expect(createInteraction(main, "a", "user-form", { ...card, initiative: false }).status).toBe("pending");
		expect(initiativeState(other).enabled).toBe(false);
	});
	it("requires skippable unsolicited forms and exposes bounded follow-up instructions", () => {
		expect(() => createInteraction(main, "a", "one", { ...card, allowSkip: false })).toThrow("skipping");
		const prompt = initiativePrompt(main);
		expect(prompt).toContain("--max-runs 1");
		expect(prompt).toContain("Never create workspace tasks");
		expect(prompt).toContain('"canSuggest":true');
		main.append({type:"CUSTOM_MESSAGE",actor_id:"user",payload:{kind:"main-initiative",data:{enabled:false}}});
		expect(initiativePrompt(main)).toContain('"canSuggest":true');
	});
 it("retains live initiative policy on every prompt rebuild and excludes it from workspace prompts",()=>{
  const deps={cwd:dir,agentDir:undefined,mainDir:dir,memoryDir:undefined,isMainAgent:true,
   mainInitiativePrompt:()=>initiativePrompt(main),
   resourceLoader:{getAppendSystemPrompt:()=>[],getSkills:()=>({skills:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>undefined},
   sessionManager:{listSessions:()=>[],getActiveSessionId:()=>undefined},toolOptions:{read:{autoResizeImages:false},cli:{}}};
  const build=createPromptBuilder(deps as never);
  expect(build([])).toContain('[Main agent initiative');
  const first=createInteraction(main,"a","one",card); answerInteraction(main,"a",first.id,{kind:"skip"});expect(build([])).toContain('"canSuggest":false');
  const project=createPromptBuilder({...deps,isMainAgent:false} as never);
  expect(project([])).not.toContain('[Main agent initiative');
 });

});
