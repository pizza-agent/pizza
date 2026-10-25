// PTY driver for pizza TUI testing.
import pty from "node-pty";
import { Screen } from "./vt.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIZZA = process.env.PIZZA_CLI || `${REPO_ROOT}/dist/src/cli.js`;
const COLS = parseInt(process.env.TUI_COLS || "100", 10);
const ROWS = parseInt(process.env.TUI_ROWS || "30", 10);
const WORK = process.env.TUI_WORK ? (fs.mkdirSync(process.env.TUI_WORK, { recursive: true }), process.env.TUI_WORK) : fs.mkdtempSync(path.join(os.tmpdir(), "pizza-tui-"));

export class TuiDriver {
  constructor(args = []) {
    this.screen = new Screen(COLS, ROWS);
    this.proc = pty.spawn(process.execPath, ["--experimental-sqlite", PIZZA, ...args], {
      name: "xterm-256color",
      cols: COLS, rows: ROWS,
      cwd: WORK,
      env: {
        ...process.env,
        TERM: "xterm-256color", COLORTERM: "truecolor", PIZZA_SKIP_VERSION_CHECK: "1",
        // Isolate test writes from the real agent dir; tests can opt out with TUI_AGENT_DIR=real
        PIZZA_CODING_AGENT_DIR: process.env.TUI_AGENT_DIR || "/tmp/pizza-test-agent",
      },
    });
    this.proc.onData(d => this.screen.feed(d));
    this.exited = false;
    this.proc.onExit(() => { this.exited = true; });
    this.work = WORK;
  }
  send(s) { this.proc.write(s); }
  key(name) {
    const map = {
      enter: "\r", esc: "\x1b", tab: "\t", backspace: "\x7f",
      up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
      "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+l": "\x0c", "ctrl+o": "\x0f",
      "ctrl+p": "\x10", "ctrl+t": "\x14", "ctrl+g": "\x07", "ctrl+v": "\x16",
      "ctrl+z": "\x1a", "shift+tab": "\x1b[Z", "ctrl+left": "\x1b[1;5D",
      "ctrl+right": "\x1b[1;5C", "alt+up": "\x1b[1;3A", "alt+enter": "\x1b\r",
      "shift+t": "T", "ctrl+a": "\x01", "ctrl+x": "\x18", "ctrl+s": "\x13",
      home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
      "ctrl+u": "\x15", "ctrl+k": "\x0b", "ctrl+w": "\x17", "ctrl+e": "\x05",
      "ctrl+b": "\x02", "ctrl+f": "\x06", "ctrl+n": "\x0e",
    };
    if (!(name in map)) throw new Error(`unknown key ${name}`);
    this.proc.write(map[name]);
  }
  // type literal text (paste-safe: bracketed paste)
  type(s) { this.proc.write(s); }
  paste(s) { this.proc.write(`\x1b[200~${s}\x1b[201~`); }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  async waitFor(text, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.screen.contains(text)) return true;
      if (this.exited) return false;
      await this.sleep(80);
    }
    return false;
  }
  async waitIdle(ms = 300) { await this.sleep(ms); }
  async waitForFn(fn, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn(this.screen)) return true;
      if (this.exited) return false;
      await this.sleep(80);
    }
    return false;
  }
  dump(name = "screen") {
    const txt = this.screen.text();
    fs.writeFileSync(`${WORK}/${name}.txt`, txt);
    return txt;
  }
  shot(label) {
    console.log(`\n===== ${label} =====`);
    console.log(this.screen.text());
    console.log(`===== end ${label} =====\n`);
  }
  kill() { try { this.proc.kill(); } catch {} }
}
