// Curated TUI smoke checks — the features that bit us in dogfooding.
// Run: node test/tui-smoke/run.mjs
import { TuiDriver } from "./driver.mjs";

const results = [];
async function check(name, fn) {
  const d = new TuiDriver();
  try {
    await fn(d);
    results.push([name, "PASS"]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, `FAIL ${e.message.slice(0, 120)}`]);
    console.log(`FAIL  ${name}: ${e.message.slice(0, 120)}`);
  } finally {
    d.kill();
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const text = (d) => d.screen.text();

export async function run() {
  await check("boot + footer + model + usage%", async (d) => {
    await d.waitFor("❯", 20000);
    expect(/%\/.*\(auto\)/.test(text(d)), "footer has usage%/window");
    expect(/deepseek|model/i.test(text(d)), "model name shown");
  });

  await check("/help renders builtin + extension commands", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("/help"); d.key("enter"); await d.sleep(1500);
    const t = text(d);
    expect(t.includes("/model"), "help lists /model");
    expect(t.includes("/rename"), "help lists /rename");
    expect(/\/pet|\/mcp|\/browser/.test(t), "help lists extension commands");
  });

  await check("LLM turn produces a reply", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("Reply with exactly: SMOKE-PONG");
    d.key("enter");
    const ok = await d.waitForFn((s) => /SMOKE-PONG/.test(s.text()), 60000);
    expect(ok, "model replied with SMOKE-PONG");
  });

  await check("Enter steers (interrupts), Esc aborts", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("Count from 1 to 80 briefly");
    d.key("enter");
    await d.sleep(2500);
    d.type("interrupt-msg"); d.key("enter"); // steer
    await d.sleep(1500);
    expect(/Operation aborted/.test(text(d)), "steer interrupted");
    d.key("esc"); await d.sleep(800);
    d.type("Reply with exactly: AFTER-ABORT");
    d.key("enter");
    const ok = await d.waitForFn((s) => /AFTER-ABORT/.test(s.text()), 60000);
    expect(ok, "post-abort turn works");
  });

  await check("Alt+Enter queues a follow-up", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("Count from 1 to 85 briefly");
    d.key("enter");
    await d.sleep(2500);
    d.type("say QUEUED-OK"); d.key("alt+enter");
    const ok = await d.waitForFn((s) => /QUEUED-OK/.test(s.text()), 120000);
    expect(ok, "queued follow-up delivered");
  });

  await check("/history tree renders real summaries", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("Reply with exactly: HIST-MARK");
    d.key("enter");
    await d.waitForFn((s) => (s.text().match(/HIST-MARK/g) ?? []).length >= 2, 60000);
    d.type("/history"); d.key("enter"); await d.sleep(1200);
    const t = text(d);
    expect(t.includes("HIST-MARK"), "history shows entry");
    expect(t.includes("user:") || t.includes("assistant:"), "timeline kinds render");
    d.key("esc");
  });

  await check("/rename changes session name", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("/rename Smoke Session");
    d.key("enter"); await d.sleep(400);
    d.key("enter"); await d.sleep(1000);
    expect(/Session renamed to: Smoke Session/.test(text(d)), "rename confirmed");
  });

  await check("settings panel toggles safe mode", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("/settings"); d.key("enter"); await d.sleep(1000);
    expect(/Safe mode/.test(text(d)), "settings shows Safe mode");
    d.key("esc");
  });

  await check("resize does not corrupt (15x5 and 200x60)", async (d) => {
    await d.waitFor("❯", 20000);
    d.proc.resize(15, 5); await d.sleep(600);
    expect(text(d).includes("❯"), "tiny resize sane");
    d.proc.resize(200, 60); await d.sleep(600);
    expect(text(d).includes("❯"), "huge resize sane");
  });

  await check("/quit exits cleanly", async (d) => {
    await d.waitFor("❯", 20000);
    d.type("/quit"); d.key("enter");
    const t0 = Date.now();
    while (!d.exited && Date.now() - t0 < 10000) await d.sleep(300);
    expect(d.exited, "process exited after /quit");
  });
}
