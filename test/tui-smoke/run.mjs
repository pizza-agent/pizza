#!/usr/bin/env node
// Standalone TUI smoke suite. Requires: dist/ built + real agent dir.
//   TUI_AGENT_DIR=/path/to/agent node test/tui-smoke/run.mjs
// Optional env: TUI_COLS, TUI_ROWS, PIZZA_CLI (custom dist path)
import { run } from "./checks.mjs";
await run();
console.log("\nDone.");
