/**
 * Bundle the CLI into dist/src/ preserving lazy boundaries.
 *
 * Entries:
 *   src/cli.ts       -> dist/src/cli.js        (tiny shim: prelude + import)
 *   src/cli-main.ts  -> dist/src/cli-main.js   (bundled static graph)
 *
 * Why two entries: cli.ts deliberately imports cli-main dynamically so the
 * prelude's warning suppression and compile-cache setup run before the heavy
 * graph links. Keeping that shape means cli.js stays a 20-line shim and the
 * real work lands in cli-main.js.
 *
 * Every `import("./x.js")` is kept external and rewritten to point at the
 * tsc emit location, so the lazy boundaries (modes, subcommand handlers,
 * session graph) resolve exactly where tsc emitted them.
 *
 * Path mapping mirrors the tsc emit layout:
 *   src/**      -> dist/src/**
 *   packages/** -> dist/packages/**
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(root, "dist/src");

/** Map a resolved source file to its tsc emit location under dist/. */
function toDistPath(sourcePath) {
	const rel = path.relative(root, sourcePath);
	if (rel.startsWith("src" + path.sep)) {
		return path.join(root, "dist", rel.replace(/\.(ts|mts|tsx)$/, ".js"));
	}
	if (rel.startsWith("packages" + path.sep)) {
		return path.join(root, "dist", rel.replace(/\.(ts|mts|tsx)$/, ".js"));
	}
	return sourcePath;
}

/** Bundled chunks land next to the entry in dist/src/, so specifiers are
 * always expressed relative to OUT_DIR. */
const keepLocalDynamicImports = {
	name: "keep-local-dynamic-imports",
	setup(b) {
		b.onResolve({ filter: /^[./]/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			const resolved = path.resolve(args.resolveDir, args.path);
			const distPath = toDistPath(resolved);
			let specifier = path.relative(OUT_DIR, distPath).split(path.sep).join("/");
			if (!specifier.startsWith(".")) specifier = "./" + specifier;
			return { path: specifier, external: true };
		});
	},
};

await build({
	entryPoints: [
		path.join(root, "src/cli.ts"),
		path.join(root, "src/cli-main.ts"),
	],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	sourcemap: true,
	splitting: true,
	plugins: [keepLocalDynamicImports],
	outdir: OUT_DIR,
});

console.log("bundled dist/src/cli.js + cli-main.js");
