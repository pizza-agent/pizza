#!/usr/bin/env node
import "../prelude.js";

await import("./register-bedrock.js");
// Statically embed pi-ai OAuth flows into the compiled Bun binary
// (lazyOAuth dynamic loaders would otherwise not resolve).
await import("@earendil-works/pi-ai/bun-oauth").then((m) => m.registerBunOAuthFlows());
await import("../cli-main.js");
