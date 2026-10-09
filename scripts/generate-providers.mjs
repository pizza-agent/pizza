#!/usr/bin/env node
/**
 * Generate `dist/providers.json`: a map of provider id -> display name,
 * sourced from pi-ai built-in providers (`builtinProviders()`).
 *
 * Consumed by non-TS runtimes that cannot import pi-ai directly:
 *   - apps/desktop/src/bridge.rs (`list_providers`)
 *   - apps/web/scripts/dev-bridge.mjs (`listProviders`)
 *
 * Keep in sync with `getProviderDisplayName()` in src/core/model-registry.ts.
 * Run via `npm run generate-providers` (also part of `npm run build`).
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
const outFile = path.join(outDir, "providers.json");

// Display-name overrides where pizza wants a different label than pi-ai.
// Keep in sync with PROVIDER_NAME_OVERRIDES in src/core/model-registry.ts.
const overrides = {};

const providers = {};
for (const provider of builtinProviders()) {
	providers[provider.id] = overrides[provider.id] ?? provider.name;
}

// Providers implemented in pizza's own layer (not pi-ai's catalog).
// Keep in sync with getBuiltinFlows() in src/core/oauth.ts.
providers["devin"] = "Devin (Devin CLI account)";

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify(providers, null, 2) + "\n", "utf8");

const count = Object.keys(providers).length;
console.log(`[generate-providers] wrote ${count} providers to ${path.relative(process.cwd(), outFile)}`);
