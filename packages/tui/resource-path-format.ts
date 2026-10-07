/**
 * Pure formatting helpers for resource paths and their provenance labels.
 *
 * These were private methods on InteractiveMode. They are pure — the only
 * ambient inputs are the user's home directory and (for one function) the
 * session cwd, both passed in explicitly — so they belong outside a 5800-line
 * UI class where they can be unit-tested directly.
 *
 * "Resources" here are skills, extensions, and memory files, which may come
 * from the project, the user config dir, an npm package, or a git checkout.
 * The display goal is to show the shortest label that still identifies where a
 * resource came from.
 */

import os from "node:os";
import path from "node:path";
import { parseGitUrl } from "../../src/utils/git.js";
import type { SourceInfo } from "../../src/core/source-info.js";

/** Scope buckets used to group resources in the startup listing. */
export type ScopeGroup = "user" | "project" | "path";

/** Display label describing where a resource came from. */
export interface DisplaySourceInfo {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
}

/** Whether the resource came from a package manager (npm or git). */
export function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

/** Abbreviate the user's home directory to `~`. */
export function formatDisplayPath(p: string, homeDir: string = os.homedir()): string {
	const windowsPath = /^[a-z]:[\\/]/i.test(p) || /^[a-z]:[\\/]/i.test(homeDir) || p.startsWith("\\\\") || homeDir.startsWith("\\\\");
	const candidate = windowsPath ? p.toLowerCase() : p;
	const home = windowsPath ? homeDir.toLowerCase() : homeDir;
	if (candidate === home) return "~";
	if (candidate.startsWith(`${home}${windowsPath ? "\\" : "/"}`)) {
		return `~${p.slice(homeDir.length).replace(/\\/g, "/")}`;
	}
	return p;
}

/** True when `relativePath` stays inside its base (no `..`, not absolute). */
function isContainedRelativePath(relativePath: string): boolean {
	return (
		relativePath !== "" &&
		relativePath !== "." &&
		!relativePath.startsWith("..") &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
}

/**
 * Render a path relative to the session cwd when it lives inside it, otherwise
 * fall back to the `~`-abbreviated absolute path.
 */
export function formatContextPath(p: string, cwd: string, homeDir?: string): string {
	const windowsPath = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\");
	const pathApi = windowsPath ? path.win32 : path.posix;
	const resolvedCwd = pathApi.resolve(cwd);
	const absolutePath = pathApi.isAbsolute(p) ? pathApi.resolve(p) : pathApi.resolve(resolvedCwd, p);
	const relativePath = pathApi.relative(resolvedCwd, absolutePath);
	const isInsideCwd =
		relativePath === "" ||
		(!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${pathApi.sep}`) &&
			!pathApi.isAbsolute(relativePath));

	if (isInsideCwd) {
		return relativePath || ".";
	}
	return formatDisplayPath(absolutePath, homeDir);
}

/**
 * Shorten a resource path for display, relative to its package root when the
 * resource came from a package.
 */
export function getShortPath(fullPath: string, sourceInfo?: SourceInfo, homeDir?: string): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (isContainedRelativePath(relativePath)) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2]!;
	}

	const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1]!;
	}

	return formatDisplayPath(fullPath, homeDir);
}

/** Split a display path into meaningful segments (drops `~` and empties). */
export function getCompactDisplayPathSegments(resourcePath: string, homeDir?: string): string[] {
	return formatDisplayPath(resourcePath, homeDir)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

/** The last meaningful path segment — usually the file name. */
export function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo, homeDir?: string): string {
	const shortPath = getShortPath(resourcePath, sourceInfo, homeDir);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1]!;
	}
	return shortPath;
}

/** Package identity for a package-sourced resource (`npm:x` → `x`). */
export function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

/**
 * Label for an extension: `package:subpath`, collapsing an `index` file to just
 * the package name, and falling back to the plain file label when the extension
 * is not package-sourced.
 */
export function getCompactExtensionLabel(
	resourcePath: string,
	sourceInfo?: SourceInfo,
	homeDir?: string,
): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo, homeDir);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo, homeDir);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo, homeDir).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/")
		? shortPath.slice("extensions/".length)
		: shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

/** Human-readable provenance label plus the colour used to render it. */
export function getDisplaySourceInfo(sourceInfo?: SourceInfo): DisplaySourceInfo {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") return { label: "user", color: "muted" };
		if (scope === "project") return { label: "project", color: "muted" };
		if (scope === "temporary") return { label: "path", scopeLabel: "temp", color: "muted" };
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return {
			label: "path",
			scopeLabel: scope === "temporary" ? "temp" : undefined,
			color: "muted",
		};
	}

	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel, color: "accent" };
}

/** Which startup-listing bucket a resource belongs to. */
export function getScopeGroup(sourceInfo?: SourceInfo): ScopeGroup {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

/**
 * Look up provenance for a path, walking up to the nearest ancestor entry.
 * Resource maps are keyed by directory for package-provided trees.
 */
export function findSourceInfoForPath(
	p: string,
	sourceInfos: Map<string, SourceInfo>,
): SourceInfo | undefined {
	const exact = sourceInfos.get(p);
	if (exact) return exact;

	let current = p;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}

	return undefined;
}

/** `<label> <shortPath>`, or just the display path when provenance is unknown. */
export function formatPathWithSource(p: string, sourceInfo?: SourceInfo, homeDir?: string): string {
	if (sourceInfo) {
		const shortPath = getShortPath(p, sourceInfo, homeDir);
		const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
		const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
		return `${labelText} ${shortPath}`;
	}
	return formatDisplayPath(p, homeDir);
}