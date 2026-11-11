import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { annotateTextWithLineAnchors } from "./line-anchors.js";
import { resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";
import { toolRenderBridge as tui } from "./render-bridge.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	anchors: Type.Optional(
		Type.Union([Type.Literal("line"), Type.Literal("none")], {
			description:
				'Whether to include hashline anchors in text output. "line" prefixes each line with <line>#<2-hex-hash> for use with edit range. Default: "line". Use "none" only when raw file text is required.',
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function formatReadCall(
	args: { path?: string; file_path?: string; offset?: number; limit?: number } | undefined,
	theme: typeof import("../../../packages/tui/theme/theme.js").theme,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const offset = args?.offset;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let pathDisplay = path === null ? invalidArg : path ? tui().theme.fg("accent", path) : tui().theme.fg("toolOutput", "...");
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : "";
		pathDisplay += tui().theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
	}
	return `${tui().theme.fg("toolTitle", tui().theme.bold("read"))} ${pathDisplay}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function formatTextReadOutput(text: string, startLine: number, anchors: "line" | "none"): string {
	return anchors === "line" ? annotateTextWithLineAnchors(text, startLine) : text;
}

function normalizeTextForAnchors(text: string, anchors: "line" | "none"): string {
	return anchors === "line" ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : text;
}

function formatReadResult(
	args: { path?: string; file_path?: string; offset?: number; limit?: number } | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../../packages/tui/theme/theme.js").theme,
	showImages: boolean,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result as any, showImages);
	const lang = rawPath ? tui().getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? tui().highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : tui().theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${tui().theme.fg("muted", `\n... (${remaining} more lines,`)} ${tui().keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${tui().theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${tui().theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${tui().theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Text output includes 2-hex hashline anchors by default (<line>#<hash> | content); pass anchors="none" only when raw text is required. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use _read line anchors as _edit edits[].range for whole-line edits.",
		],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit, anchors = "line" }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const absolutePath = resolveReadPath(path, cwd);
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									if (!resized) {
										let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// Read text content.
								const buffer = await ops.readFile(absolutePath);
								const textContent = normalizeTextForAnchors(buffer.toString("utf-8"), anchors);
								const allLines = textContent.split("\n");
								const totalFileLines = textContent.endsWith("\n") ? allLines.length - 1 : allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, totalFileLines);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = formatTextReadOutput(truncation.content, startLineDisplay, anchors);
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${formatTextReadOutput(truncation.content, startLineDisplay, anchors)}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = formatTextReadOutput(truncation.content, startLineDisplay, anchors);
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatReadCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatReadResult(context.args, result as any, options, theme, context.showImages));
			return text;
		},
	};
}

