#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 * Routes read/write/edit built-in commands to builtin-commands.ts.
 * grep, find, ls are not built-in commands — they are passed to the system shell.
 * and passes other commands to main.ts
 *
 * Kept minimal on purpose: the real entry lives in cli-main.ts and is loaded
 * with a dynamic import. Static imports are linked before any module code
 * runs, which means warnings emitted while linking vendored dependencies
 * (pi-ai's `import ... with { type: "json" }` model tables trigger Node's
 * "Importing JSON modules" ExperimentalWarning) would bypass the emitWarning
 * suppression in prelude.js. Deferring to a dynamic import makes the whole
 * graph link *after* the override is installed.
 */
import "./prelude.js";

await import("./cli-main.js");
