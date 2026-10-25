/**
 * Prelude side-effects that must run before any other module is evaluated.
 * Imported as the very first import of cli.ts so that its top-level code
 * executes before static imports pull in vendored dependencies that emit
 * Node.js experimental warnings (e.g. pi-ai's `import ... with { type: "json" }`
 * provider model tables) — warnings raised during ESM evaluation bypass the
 * emitWarning override if it is only installed in cli.ts's own body.
 */
process.title = "pizza";
process.env.PIZZA_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;
