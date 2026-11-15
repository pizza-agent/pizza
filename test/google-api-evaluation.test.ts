/** Frozen fictional records, never a user's live Drive/mail/contact data. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { McpClient } from "../src/core/mcp/index.js";
import { GoogleApiTransport } from "../src/builtin-extensions/connectors/google-api.js";
const scenarios = JSON.parse(readFileSync(new URL("./fixtures/mcp/google-api/evaluation.json", import.meta.url), "utf8"));
it.each(scenarios)("supports a read-only multi-call workflow: $question", async scenario => {
 let step = 0;
 const c = new McpClient({ name: "evaluation", version: "1" });
 let last: Record<string, any> = {}, first: Record<string, any> = {};
 await c.connect(new GoogleApiTransport(scenario.product, { token: async () => "fixture" }, async input => {
  const output = scenario.calls[step][2];
  if (String(input).endsWith("?fields=mimeType")) return Response.json({ mimeType: "text/plain" });
  step++;
  return scenario.calls[step - 1][0] === "read_file_content" ? new Response(output.content, { headers: { "Content-Type": output.mime_type } }) : Response.json(output);
 }));
 try {
  const tools = await c.listTools();
  for (const [name, args] of scenario.calls) {
   expect(tools.find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true);
   const result = await c.callTool(name, args); expect(result.isError).not.toBe(true);
   last = result.structuredContent!; if (step === 1) first = last;
  }
  const question = scenario.question as string;
  let answer: string;
  if (question.includes("name of the shared")) answer = first.files[0].name;
  else if (question.includes("approved budget amount")) answer = last.content.match(/\d+/)[0];
  else if (question.includes("who owns")) answer = last.body.content[0].paragraph.elements[0].textRun.content.split(": ")[1];
  else if (question.includes("Which revision")) answer = last.revisionId;
  else if (question.includes("sum of")) answer = String(last.values.reduce((sum: number, row: any[]) => sum + row[1], 0));
  else if (question.includes("title of the slide")) answer = last.pageElements[0].shape.text.textElements[0].textRun.content;
  else if (question.includes("what is the date")) answer = last.items[0].start.date;
  else if (question.includes("location")) answer = last.location;
  else if (question.includes("release tag")) answer = last.text.split(": ")[1];
  else answer = last.emailAddresses[0].value;
  expect(step).toBe(scenario.calls.length); expect(answer).toBe(scenario.answer);
 } finally { await c.close(); }
});
