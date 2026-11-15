import { cpSync, existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Examples can contain separately installed deployment tools and local credentials. */
export function copyReleaseContent(source, target) {
	const excluded = (part) => ["node_modules", ".wrangler", ".git", ".env"].includes(part) || part.startsWith(".env.") || part.startsWith(".dev.vars");
	for (const entry of ["CHANGELOG.md", "docs", "examples"]) {
		const path = resolve(source, entry);
		if (!existsSync(path)) continue;
		cpSync(path, resolve(target, entry), {
			recursive: true,
			filter: (candidate) => !relative(source, candidate).split(sep).some(excluded),
		});
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	copyReleaseContent(root, resolve(root, "dist"));
}
