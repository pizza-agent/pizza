/**
 * Prelude side-effects that must run before any other module is evaluated.
 * Imported as the very first import of cli.ts so that its top-level code
 * executes before static imports pull in vendored dependencies that emit
 * Node.js experimental warnings (e.g. pi-ai's `import ... with { type: "json" }`
 * provider model tables) — warnings raised during ESM evaluation bypass the
 * emitWarning override if it is only installed in cli.ts's own body.
 */
import { createRequire } from "node:module";

process.title = "pizza";
process.env.PIZZA_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Enable the V8 compile cache so subsequent `pizza` invocations skip
// parsing/compiling the (large) ESM module graph — measured ~60% faster
// cold-start for `pizza --version`. Node >= 22.8 exposes
// module.enableCompileCache. Look it up on the required module object:
// a named ESM import throws during linking on Bun and older Node, before
// any try/catch can run, and that would abort the compiled binary.
const require = createRequire(import.meta.url);
try {
	const nodeModule = require("node:module") as { enableCompileCache?: () => unknown };
	nodeModule.enableCompileCache?.();
} catch {
	// Not fatal: a missing API or an unwritable cache dir only loses the speedup.
}
