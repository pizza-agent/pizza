/**
 * Install a skill directly from a GitHub repo (skills.sh directory entries are
 * `owner/repo` + a skill slug). Downloads the repo zip, locates the skill
 * directory (the dir containing SKILL.md whose name matches the slug, or whose
 * SKILL.md frontmatter `name` matches), and copies it into the user skills dir.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import extract from "extract-zip";

const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface InstallSkillResult {
	/** Installed directory name under the skills dir. */
	name: string;
	/** Absolute path of the installed skill directory. */
	path: string;
}

async function downloadRepoZip(source: string, dest: string): Promise<void> {
	const candidates = [
		// api.github.com serves the same zip; keep it first — codeload
		// (github.com/.../archive) is intermittently unreachable on some networks.
		`https://api.github.com/repos/${source}/zipball`,
		`https://github.com/${source}/archive/HEAD.zip`,
		`https://github.com/${source}/archive/refs/heads/main.zip`,
		`https://github.com/${source}/archive/refs/heads/master.zip`,
	];
	let lastStatus = "";
	for (const url of candidates) {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { "User-Agent": "pizza-skill-installer" },
		}).catch((e) => {
			throw new Error(`Failed to download ${source}: ${e instanceof Error ? e.message : String(e)}`);
		});
		if (!res.ok) {
			lastStatus = `HTTP ${res.status}`;
			continue;
		}
		const length = Number(res.headers.get("content-length") ?? 0);
		if (length > MAX_ZIP_BYTES) {
			throw new Error(`Repository archive too large (${Math.round(length / 1024 / 1024)} MB)`);
		}
		const body = await res.arrayBuffer();
		if (body.byteLength > MAX_ZIP_BYTES) {
			throw new Error(`Repository archive exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
		}
		await writeFile(dest, Buffer.from(body));
		return;
	}
	throw new Error(`Could not download ${source} (${lastStatus || "no archive found"})`);
}

function frontmatterName(skillMd: string): string | undefined {
	const head = skillMd.slice(0, 4096);
	const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(head);
	if (!fm) return undefined;
	return /^name:\s*["']?([^\s"']+)/m.exec(fm[1])?.[1];
}

/** Collect directories (relative to root) that contain a SKILL.md file. */
async function findSkillDirs(root: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
		if (depth > 8) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.isFile() && /^skill\.md$/i.test(e.name))) {
			found.push(rel);
		}
		for (const e of entries) {
			if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
				await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
			}
		}
	};
	await walk(root, "", 0);
	return found;
}

/**
 * Download `owner/repo` from GitHub, find the skill matching `slug`, and copy
 * it into `skillsDir/<slug>`. Throws a descriptive Error on failure.
 */
export async function installSkillFromGitHub(opts: {
	source: string;
	slug: string;
	skillsDir: string;
}): Promise<InstallSkillResult> {
	const { source, slug, skillsDir } = opts;
	const parts = source.split("/");
	if (parts.length !== 2 || !parts.every((p) => SAFE_COMPONENT.test(p))) {
		throw new Error(`Invalid skill source: ${source}`);
	}
	if (!SAFE_COMPONENT.test(slug)) {
		throw new Error(`Invalid skill slug: ${slug}`);
	}
	const destDir = join(skillsDir, slug);
	if (existsSync(destDir)) {
		throw new Error(`Skill "${slug}" is already installed`);
	}

	const workDir = await mkdtemp(join(tmpdir(), "pizza-skill-install-"));
	try {
		const zipPath = join(workDir, "repo.zip");
		await downloadRepoZip(source, zipPath);
		const extractDir = join(workDir, "repo");
		await extract(zipPath, { dir: extractDir });
		// GitHub zips nest everything under "<repo>-<sha>/".
		const top = (await readdir(extractDir, { withFileTypes: true })).filter((e) => e.isDirectory());
		const repoRoot = top.length === 1 ? join(extractDir, top[0].name) : extractDir;

		const skillDirs = await findSkillDirs(repoRoot);
		if (skillDirs.length === 0) {
			throw new Error(`No SKILL.md found in ${source}`);
		}
		const wanted = slug.toLowerCase();
		// Prefer a directory literally named after the slug (skills/<slug>/, etc.).
		let matches = skillDirs.filter((rel) => basename(rel).toLowerCase() === wanted);
		if (matches.length === 0) {
			// Fall back to matching the skill's frontmatter `name`.
			for (const rel of skillDirs) {
				const md = await readFile(join(repoRoot, rel, "SKILL.md"), "utf-8").catch(() => "");
				if (frontmatterName(md)?.toLowerCase() === wanted) {
					matches.push(rel);
				}
			}
		}
		if (matches.length === 0) {
			throw new Error(`Skill "${slug}" not found in ${source}`);
		}
		// Shortest path wins when the slug appears in multiple nested plugins.
		matches.sort((a, b) => a.length - b.length);
		const srcDir = matches[0] === "" ? repoRoot : join(repoRoot, matches[0]);

		await cp(srcDir, destDir, { recursive: true });
		return { name: slug, path: destDir };
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}
