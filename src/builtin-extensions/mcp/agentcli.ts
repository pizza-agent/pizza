/**
 * The `_agentcli` built-in underscore CLI command.
 *
 * Implements the AgentCLI progressive-disclosure runtime (discover → inspect → execute → observe)
 * in-process over Pizza's configured MCP servers (`mcp.json` + `pizza.registerMcpServer()`).
 *
 * MCP tools are never declared directly in the LLM request tool schema; instead the model discovers
 * and calls them dynamically via `_agentcli`:
 *
 *   _agentcli --help                              # list configured MCP servers
 *   _agentcli server list                         # list servers as JSON
 *   _agentcli server add <name> -- <cmd...>       # register a server in mcp.json
 *   _agentcli <server> --help                     # list tools offered by <server>
 *   _agentcli <server> <tool> --help              # generated flag usage from tool's JSON Schema
 *   _agentcli <server> <tool> --schema            # raw JSON Schema for <tool>
 *   _agentcli <server> <tool> --flag value ...    # execute tool (flags + optional --input JSON)
 *   _agentcli <server> resources                  # list MCP resources (if offered)
 *   _agentcli <server> resource <uri>             # read an MCP resource
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import type { AgentToolResult, BuiltinCommandDefinition, ExtensionContext } from "../../core/extensions/types.js";
import { type CallToolResult, type ContentBlock, type Tool as McpTool, toLlmContent } from "../../core/mcp/index.js";
import { getMcpToolExposure, type McpServerConfig, validateMcpServerConfig } from "../../core/mcp/servers.js";
import { formatSize, truncateMiddle } from "../../core/tools/truncate.js";
import { writeOutputFile } from "../../utils/output-files.js";
import { addMcpServerConfig, type McpServerEntry, removeMcpServerConfig } from "./config.js";
import type { McpServerConnection } from "./runtime.js";

export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

// ============================================================================
// Error taxonomy (matches agentcli)
// ============================================================================

export class AgentCliError extends Error {
	readonly code: string;
	readonly hint?: string;
	readonly details?: unknown;

	constructor(code: string, message: string, options: { hint?: string; details?: unknown } = {}) {
		super(message);
		this.name = "AgentCliError";
		this.code = code;
		this.hint = options.hint;
		this.details = options.details;
	}
}

export const agentCliErrors = {
	invalidArgument: (message: string, hint?: string) => new AgentCliError("INVALID_ARGUMENT", message, { hint }),
	notFound: (message: string, hint?: string) => new AgentCliError("NOT_FOUND", message, { hint }),
	execution: (message: string, details?: unknown) => new AgentCliError("EXECUTION_ERROR", message, { details }),
	connect: (message: string, details?: unknown) =>
		new AgentCliError("CONNECT_FAILED", message, {
			details,
			hint: "check server config/env or run `/mcp` to inspect connection state; do not blind-retry",
		}),
	auth: (message: string, serverName?: string) =>
		new AgentCliError("AUTH_REQUIRED", message, {
			hint: serverName
				? `sign in with \`/mcp login ${serverName}\` or \`pizza mcp login ${serverName}\`; do not retry with the same token`
				: "ask the user for credentials or run `/mcp login`; do not retry with the same token",
		}),
	timeout: (message: string) =>
		new AgentCliError("TIMEOUT", message, { hint: "retry, or raise --timeout-ms" }),
};

export function formatErrorEnvelope(err: AgentCliError): string {
	const errorObj: Record<string, unknown> = {
		code: err.code || "INTERNAL",
		message: err.message,
	};
	if (err.hint) errorObj.hint = err.hint;
	if (err.details !== undefined) errorObj.details = err.details;
	return JSON.stringify({ ok: false, error: errorObj });
}

// ============================================================================
// Fuzzy matching for typo suggestions
// ============================================================================

export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (Math.abs(m - n) > 3) return Number.POSITIVE_INFINITY;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		const curr = [i];
		for (let j = 1; j <= n; j++) {
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = curr;
	}
	return prev[n];
}

export function suggest(typed: string, candidates: readonly string[]): string[] {
	const lower = String(typed || "").toLowerCase();
	if (!lower) return [];
	return candidates
		.map((c) => ({ c, lower: String(c).toLowerCase() }))
		.filter(({ lower: cl }) => cl.includes(lower) || levenshtein(lower, cl) <= Math.max(1, Math.floor(cl.length / 3)))
		.sort((x, y) => levenshtein(lower, x.lower) - levenshtein(lower, y.lower))
		.map(({ c }) => c);
}

// ============================================================================
// Schema → CLI Flag compiler (matches agentcli flags.ts)
// ============================================================================

export interface ToolPropertySchema {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	default?: unknown;
	items?: { type?: string; [key: string]: unknown };
	anyOf?: unknown[];
	oneOf?: unknown[];
	allOf?: unknown[];
	$ref?: string;
	[key: string]: unknown;
}

export interface ToolInputSchema {
	type?: string;
	properties?: Record<string, ToolPropertySchema>;
	required?: string[];
	[key: string]: unknown;
}

export interface FlagSpec {
	name: string;
	type: string;
	itemType?: string;
	enum?: string[];
	default?: unknown;
	description: string;
	required: boolean;
}

export interface ComplexParam {
	name: string;
	description: string;
}

export interface FlagPlan {
	flags: Map<string, FlagSpec>;
	complex: ComplexParam[];
	required: string[];
}

const CONTROL_FLAGS = new Set(["input", "output", "schema", "refresh", "help", "timeout-ms", "no-daemon"]);

function normalizePropertyType(rawType: string | string[] | undefined): string | undefined {
	if (typeof rawType === "string") return rawType;
	if (Array.isArray(rawType)) {
		const nonNull = rawType.filter((t) => t !== "null");
		if (nonNull.length === 1) return nonNull[0];
	}
	return undefined;
}

export function buildFlagPlan(inputSchema: Record<string, unknown> | undefined): FlagPlan {
	const schema = (inputSchema ?? {}) as ToolInputSchema;
	const requiredList = Array.isArray(schema.required) ? schema.required : [];
	const required = new Set(requiredList);
	const plan: FlagPlan = { flags: new Map(), complex: [], required: requiredList };
	const props = schema.properties ?? {};
	for (const name of Object.keys(props)) {
		const ps = props[name] ?? {};
		const type = normalizePropertyType(ps.type);
		const complex =
			!type ||
			type === "object" ||
			(type === "array" && (!ps.items || !ps.items.type || ps.items.type === "object")) ||
			ps.anyOf !== undefined ||
			ps.oneOf !== undefined ||
			ps.allOf !== undefined ||
			ps.$ref !== undefined;
		if (complex) {
			plan.complex.push({ name, description: ps.description ?? "" });
		} else {
			plan.flags.set(name, {
				name,
				type,
				itemType: type === "array" ? (ps.items?.type as string | undefined) || "string" : undefined,
				enum: Array.isArray(ps.enum) ? ps.enum.map(String) : undefined,
				default: ps.default,
				description: ps.description ?? "",
				required: required.has(name),
			});
		}
	}
	return plan;
}

function coerceValue(spec: FlagSpec, raw: string): unknown {
	const type = spec.type === "array" ? spec.itemType : spec.type;
	if (type === "boolean") {
		if (raw === "true") return true;
		if (raw === "false") return false;
		throw agentCliErrors.invalidArgument(
			`invalid boolean for --${spec.name}: "${raw}"`,
			`Use --${spec.name} or --${spec.name}=true|false`,
		);
	}
	if (type === "integer" || type === "number") {
		const n = Number(raw);
		if (raw === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) {
			throw agentCliErrors.invalidArgument(`invalid ${type} for --${spec.name}: "${raw}"`);
		}
		return n;
	}
	if (spec.enum && !spec.enum.includes(raw)) {
		throw agentCliErrors.invalidArgument(
			`invalid value for --${spec.name}: "${raw}"`,
			`Allowed values: ${spec.enum.join(", ")}`,
		);
	}
	return raw;
}

function findFlagSpec(plan: FlagPlan, name: string): { key: string; spec: FlagSpec } | undefined {
	const direct = plan.flags.get(name);
	if (direct) return { key: name, spec: direct };
	// Support kebab-case flag matching snake_case or camelCase property names
	const snake = name.replace(/-/g, "_");
	const snakeSpec = plan.flags.get(snake);
	if (snakeSpec) return { key: snake, spec: snakeSpec };
	const camel = name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
	const camelSpec = plan.flags.get(camel);
	if (camelSpec) return { key: camel, spec: camelSpec };
	return undefined;
}

export interface ParsedToolArgs {
	args: Record<string, unknown>;
	opts: Record<string, string | boolean>;
}

export function parseToolArgs(plan: FlagPlan, tokens: string[], heredoc?: string): ParsedToolArgs {
	const args: Record<string, unknown> = {};
	const opts: Record<string, string | boolean> = {};
	let lastControlWaitingForHeredoc: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		if (tok === "-h") {
			opts.help = true;
			continue;
		}
		if (!tok.startsWith("--")) {
			throw agentCliErrors.invalidArgument(
				`unexpected positional argument "${tok}"`,
				"Pass values as flags, or the whole object via --input '<json>'",
			);
		}
		let body = tok.slice(2);
		let value: string | undefined;
		let hasValue = false;
		const eq = body.indexOf("=");
		if (eq >= 0) {
			value = body.slice(eq + 1);
			body = body.slice(0, eq);
			hasValue = true;
		}
		if (CONTROL_FLAGS.has(body)) {
			if (body === "schema" || body === "refresh" || body === "help" || body === "no-daemon") {
				opts[body] = hasValue ? value === "true" : true;
			} else {
				if (!hasValue) {
					if (i + 1 < tokens.length) {
						value = tokens[++i];
					} else if (heredoc !== undefined && body === "input") {
						value = heredoc;
						lastControlWaitingForHeredoc = undefined;
					} else {
						throw agentCliErrors.invalidArgument(`--${body} requires a value`);
					}
				}
				opts[body] = value as string;
			}
			continue;
		}
		const found = findFlagSpec(plan, body);
		if (!found) {
			const hints: string[] = [];
			const available = [...plan.flags.keys()].map((k) => `--${k}`).join(", ");
			if (available) hints.push(`Available flags: ${available}`);
			if (plan.complex.length) {
				hints.push(`Complex parameters (use --input): ${plan.complex.map((c) => c.name).join(", ")}`);
			}
			if (!hints.length) hints.push("Run: _agentcli <server> <tool> --help");
			throw agentCliErrors.invalidArgument(`unknown option --${body}`, hints.join(" | "));
		}
		const { key, spec } = found;
		let raw = value;
		if (!hasValue && spec.type === "boolean") {
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--") && (next === "true" || next === "false")) {
				raw = next;
				i++;
			} else {
				raw = "true";
			}
		} else if (!hasValue) {
			raw = tokens[++i];
			if (raw === undefined || raw.startsWith("--")) {
				if (raw === undefined && heredoc !== undefined) {
					raw = heredoc;
				} else {
					throw agentCliErrors.invalidArgument(
						`--${body} requires a value`,
						`Use --${body}=<value> when the value itself starts with --`,
					);
				}
			}
		}
		const parsed = coerceValue(spec, raw as string);
		if (spec.type === "array") {
			const arr = ((args[key] as unknown[]) ||= []);
			arr.push(parsed);
		} else {
			args[key] = parsed;
		}
	}
	if (heredoc !== undefined && opts.input === undefined && lastControlWaitingForHeredoc === undefined) {
		// If heredoc was provided and --input was not given, treat heredoc as --input JSON when it looks like JSON
		const trimmed = heredoc.trim();
		if (trimmed.startsWith("{")) {
			opts.input = heredoc;
		}
	}
	return { args, opts };
}

export function readInputJson(spec: string, cwd: string): Record<string, unknown> {
	let rawText: string;
	if (spec.startsWith("@")) {
		const filePath = resolve(cwd, spec.slice(1));
		try {
			rawText = readFileSync(filePath, "utf8");
		} catch (e) {
			const err = e as Error;
			throw agentCliErrors.invalidArgument(`cannot read --input file: ${spec.slice(1)}`, err.message);
		}
	} else {
		rawText = spec;
	}
	let value: unknown;
	try {
		value = JSON.parse(rawText);
	} catch (e) {
		const err = e as Error;
		throw agentCliErrors.invalidArgument("--input is not valid JSON", err.message);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw agentCliErrors.invalidArgument("--input must be a JSON object");
	}
	return value as Record<string, unknown>;
}

export function validateRequired(plan: FlagPlan, args: Record<string, unknown>): void {
	const missing: string[] = [];
	for (const name of plan.required) {
		if (args[name] !== undefined) continue;
		const spec = plan.flags.get(name);
		if (spec && spec.default !== undefined) continue;
		missing.push(name);
	}
	if (!missing.length) return;
	const forms = missing.map((n) => (plan.flags.has(n) ? `--${n}` : `${n} (via --input)`));
	throw agentCliErrors.invalidArgument(
		`missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
		`Pass ${forms.join(", ")} — see --help`,
	);
}

export function renderToolHelp(serverName: string, tool: McpTool): string {
	const plan = buildFlagPlan(tool.inputSchema);
	const lines: string[] = [];
	lines.push(`${serverName} ${tool.name}`);
	const desc = tool.description?.trim() || tool.title || tool.annotations?.title;
	if (desc) lines.push("", desc);
	lines.push("", "Usage:", `  _agentcli ${serverName} ${tool.name} [flags]`);
	const flags = [...plan.flags.values()];
	const req = flags.filter((f) => f.required);
	const opt = flags.filter((f) => !f.required);
	if (req.length) {
		lines.push("", "Required:");
		for (const f of req) {
			lines.push(`  --${f.name} <${f.type}>${f.description ? `    ${f.description}` : ""}`);
		}
	}
	if (opt.length || plan.complex.length) {
		lines.push("", "Optional:");
		for (const f of opt) {
			const parts: string[] = [f.description];
			if (f.enum) parts.push(`choices: ${f.enum.join("|")}`);
			if (f.default !== undefined) parts.push(`default: ${JSON.stringify(f.default)}`);
			const d = parts.filter(Boolean).join("; ");
			lines.push(`  --${f.name} <${f.type}>${d ? `    ${d}` : ""}`);
		}
		for (const c of plan.complex) {
			lines.push(`  ${c.name}    ${c.description || "complex parameter"} — pass via --input '<json>'`);
		}
	}
	lines.push(
		"",
		"Global:",
		"  --input <json|@file>      Full JSON arguments object (flags override --input keys)",
		"  --output <json|text>      Output format (default: json)",
		"  --schema                  Print the raw tool input schema",
		"  --refresh                 Refresh the server's tool list before running",
		"  --timeout-ms <n>          Request timeout in milliseconds",
	);
	return lines.join("\n");
}

// ============================================================================
// Result conversion & truncation
// ============================================================================

function parseMaybeEncoded(text: string, maxDepth = 3): unknown {
	let v: unknown = text;
	for (let i = 0; typeof v === "string" && i <= maxDepth; i++) {
		try {
			v = JSON.parse(v);
		} catch {
			break;
		}
	}
	return v;
}

function extractText(result: CallToolResult): string {
	return (result.content ?? [])
		.filter((c): c is Extract<ContentBlock, { type: "text" }> => Boolean(c && c.type === "text"))
		.map((c) => c.text || "")
		.join("\n");
}

export function extractResultData(mcp: CallToolResult): { data: unknown; text?: string; isError: boolean } {
	let data: unknown;
	if (mcp.structuredContent !== undefined) {
		data = mcp.structuredContent;
	} else {
		const items = mcp.content ?? [];
		if (items.length === 0) {
			data = null;
		} else if (items.every((c) => c && c.type === "text")) {
			data = parseMaybeEncoded(
				items.map((c) => (c as Extract<ContentBlock, { type: "text" }>).text || "").join("\n"),
			);
		} else {
			data = { content: items };
		}
	}
	const text = extractText(mcp);
	return { data, text: text === "" ? undefined : text, isError: Boolean(mcp.isError) };
}

function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

export async function blockToModelContent(
	server: string,
	block: ContentBlock,
	hasResources: boolean,
): Promise<(TextContent | ImageContent)[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = hasResources ? `. Read it with: _agentcli ${server} resource "${block.uri}"` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await writeOutputFile("pizza-mcp", extensionOf(uri), data);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

export async function limitTextOutput(
	text: string,
	extraBlocks: ImageContent[] = [],
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const truncation = truncateMiddle(text, MCP_OUTPUT_MAX_BYTES);
	if (!truncation.truncated) {
		return { content: [{ type: "text", text }, ...extraBlocks] };
	}
	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await writeOutputFile("pizza-mcp", ".txt", text);
		where = `[Full output: ${fullOutputPath} (read it with _read offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	const limitedText = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
	return {
		content: [{ type: "text", text: limitedText }, ...extraBlocks],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

// ============================================================================
// Runtime Host interface provided by the MCP extension
// ============================================================================

export interface AgentCliServerView {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	ready?: Promise<void>;
}

export interface AgentCliHost {
	refreshConfig?(ctx: ExtensionContext): void;
	getServers(): readonly AgentCliServerView[];
	getConfigErrors(): readonly string[];
	waitForServer(name: string, signal?: AbortSignal): Promise<AgentCliServerView | undefined>;
	waitForAllServers(signal?: AbortSignal): Promise<void>;
	addServer(
		name: string,
		config: McpServerConfig,
		options: { local?: boolean; cwd: string },
	): Promise<{ path: string; replaced: boolean }>;
	removeServer(name: string, options: { local?: boolean; cwd: string }): Promise<{ path: string; removed: boolean }>;
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n", 1)[0]?.trim() ?? "";
}

function isEnabled(server: AgentCliServerView): boolean {
	return server.entry.config.enabled !== false;
}

function visibleTools(server: AgentCliServerView): McpTool[] {
	const tools = server.connection?.tools ?? [];
	return tools.filter((tool) => getMcpToolExposure(server.entry.config, tool.name) !== "hidden");
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

function describeServerState(server: AgentCliServerView): string {
	if (!isEnabled(server)) return "disabled";
	const conn = server.connection;
	if (!conn) return "starting";
	switch (conn.state) {
		case "connected": {
			const count = visibleTools(server).length;
			return `connected (${count} tool${count === 1 ? "" : "s"}${conn.hasResources ? ", resources" : ""})`;
		}
		case "needs-auth":
			return "needs sign-in (/mcp login)";
		case "failed":
			return `failed: ${firstLine(conn.error ?? "unknown error")}`;
		default:
			return conn.state;
	}
}

export const AGENTCLI_HELP = `_agentcli — Discover and call MCP servers and tools dynamically (no per-tool schema bloat)

Usage:
  _agentcli -h                                  List configured MCP servers
  _agentcli <server> -h                         List tools offered by <server>
  _agentcli <server> <tool> -h                  Show generated flag usage for <tool>
  _agentcli <server> <tool> --schema            Print raw JSON Schema for <tool>
  _agentcli <server> <tool> [--flags...]        Call <tool> on <server>
  _agentcli <server> resources [--cursor <c>]   List MCP resources offered by <server>
  _agentcli <server> templates [--cursor <c>]   List MCP resource templates offered by <server>
  _agentcli <server> resource <uri>             Read an MCP resource from <server>
  _agentcli server list [--wait] [--output json|text]    List configured servers
  _agentcli server tools <server> [--refresh]   List a server's tools
  _agentcli server add <name> [options] ...     Add an MCP server to mcp.json
  _agentcli server remove <name> [-l]           Remove an MCP server from mcp.json

Core loop: discover (_agentcli -h) → inspect (_agentcli <server> -h → _agentcli <server> <tool> -h) → execute.`;

function renderTopLevelHelp(host: AgentCliHost): string {
	const servers = host.getServers();
	const errors = host.getConfigErrors();
	const lines = [AGENTCLI_HELP];
	if (servers.length === 0) {
		lines.push(
			"",
			"No MCP servers configured yet:",
			"  _agentcli server add <name> -- <command> [args...]   # stdio MCP server",
			"  _agentcli server add <name> --url <http-url>         # Streamable HTTP MCP server",
			`  (or edit ${resolve(getAgentDir(), "mcp.json")} / ${CONFIG_DIR_NAME}/mcp.json)`,
		);
	} else {
		lines.push("", "Configured servers (_agentcli <server> <tool> ...):");
		for (const s of servers) {
			const kind = "url" in s.entry.config ? "http" : "stdio";
			const detail = describeTransport(s.entry);
			const summary = firstLine(s.entry.config.description) || firstLine(s.connection?.instructions);
			const state = describeServerState(s);
			lines.push(
				`  ${s.entry.name.padEnd(18)} ${kind.padEnd(6)} ${state} — ${summary ? `${summary} (${detail})` : detail}`,
			);
		}
		lines.push("", "  _agentcli <server> --help    List a server's tools");
	}
	if (errors.length > 0) {
		lines.push("", "Configuration errors:");
		for (const err of errors) lines.push(`  ${err}`);
	}
	return lines.join("\n");
}

function renderServerHelp(server: AgentCliServerView): string {
	const name = server.entry.name;
	const conn = server.connection;
	const tools = visibleTools(server);
	const lines = [`${name} — MCP server (${tools.length} tool${tools.length === 1 ? "" : "s"})`];
	const summary = server.entry.config.description?.trim() || conn?.instructions?.trim();
	if (summary) lines.push("", summary);
	lines.push("", "Usage:", `  _agentcli ${name} <tool> [flags]`, "");
	if (tools.length === 0) {
		lines.push("Tools: (none)");
	} else {
		lines.push("Tools:");
		for (const t of tools) {
			const tName = String(t.name);
			const pad = tName.length >= 28 ? "  " : " ".repeat(28 - tName.length);
			const desc = firstLine(t.description) || t.title || t.annotations?.title || "";
			lines.push(`  ${tName}${pad}${desc}`);
		}
	}
	if (conn?.hasResources) {
		lines.push(
			"",
			"Resources:",
			`  _agentcli ${name} resources              List resources`,
			`  _agentcli ${name} templates              List resource templates`,
			`  _agentcli ${name} resource <uri>         Read a resource by URI`,
		);
	}
	lines.push("", `  _agentcli ${name} <tool> --help    Help for a specific tool`);
	return lines.join("\n");
}

// ============================================================================
// Subcommand: `_agentcli server ...`
// ============================================================================

function parseKeyValuePairs(pairs: string[], flagName: string, allowColon = false): Record<string, string> {
	const out: Record<string, string> = {};
	for (const kv of pairs) {
		let idx = kv.indexOf("=");
		if (idx <= 0 && allowColon) idx = kv.indexOf(":");
		if (idx <= 0) {
			throw agentCliErrors.invalidArgument(
				`invalid --${flagName} "${kv}"`,
				allowColon ? 'Expected "Name: value" or KEY=value' : "Expected KEY=value",
			);
		}
		out[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
	}
	return out;
}

async function handleServerSubcommand(
	host: AgentCliHost,
	tokens: string[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<string> {
	const sub = tokens[0];
	if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
		const names = host.getServers().map((s) => s.entry.name);
		return [
			"Usage:",
			"  _agentcli server list [--wait] [--output json|text]",
			"  _agentcli server tools <server> [--refresh] [--output json|text]",
			"  _agentcli server add <name> [--local] [--url <url> | -- <command> [args...]] [--env KEY=VAL] [--header 'Name: val'] [--description <text>]",
			"  _agentcli server remove <name> [--local]",
			"",
			`Configured servers: ${names.join(", ") || "none"}`,
		].join("\n");
	}

	const rest = tokens.slice(1);

	if (sub === "list") {
		// Discovery must not wait behind unrelated slow or unreachable servers.
		if (rest.includes("--wait")) await host.waitForAllServers(signal);
		const isText = rest.includes("text") || rest.includes("--output=text");
		const rows: Array<{
			name: string;
			type: string;
			enabled: boolean;
			state: string;
			tools: number;
			scope?: string;
			config?: McpServerConfig;
			resources?: boolean;
			url?: string;
			command?: string;
			description?: string;
			error?: string;
		}> = host.getServers().map((s) => {
			const cfg = s.entry.config;
			const type = "url" in cfg ? "http" : "stdio";
			return {
				name: s.entry.name,
				scope: s.entry.scope,
				...(rest.includes("--include-config") ? { config: s.entry.config } : {}),
				type,
				enabled: isEnabled(s),
				state: s.connection?.state ?? (isEnabled(s) ? "starting" : "disabled"),
				tools: visibleTools(s).length,
				...(s.connection?.hasResources ? { resources: true } : {}),
				...("url" in cfg ? { url: cfg.url } : { command: [cfg.command, ...(cfg.args ?? [])].join(" ") }),
				...(cfg.description ? { description: cfg.description } : {}),
				...(s.connection?.error && s.connection.state !== "connected" ? { error: s.connection.error } : {}),
			};
		});
		if (isText) {
			if (rows.length === 0) return "No MCP servers configured.";
			return rows
				.map(
					(r) =>
						`${r.name.padEnd(16)}${r.type.padEnd(8)}${String(r.state).padEnd(14)}${r.url ?? r.command ?? ""}`,
				)
				.join("\n");
		}
		return JSON.stringify({ ok: true, data: rows, warnings: host.getConfigErrors() }, null, 2);
	}

	if (sub === "tools") {
		const name = rest.find((t) => !t.startsWith("-"));
		if (!name) {
			throw agentCliErrors.invalidArgument("missing server name", "Usage: _agentcli server tools <server> [--refresh]");
		}
		const refresh = rest.includes("--refresh");
		const isText = rest.includes("text") || rest.includes("--output=text");
		const server = await requireConnectedServer(host, name, refresh, signal);
		const tools = visibleTools(server);
		if (isText) {
			return tools.map((t) => `${String(t.name).padEnd(28)}${firstLine(t.description)}`).join("\n");
		}
		return JSON.stringify(
			{
				ok: true,
				data: tools.map((t) => ({
					name: t.name,
					description: t.description ?? "",
					...(rest.includes("--include-schema") ? { inputSchema: t.inputSchema ?? { type: "object" } } : {}),
				})),
			},
			null,
			2,
		);
	}

	if (sub === "add") {
		let local = false;
		let jsonConfig: unknown;
		let url: string | undefined;
		let cwd: string | undefined;
		let description: string | undefined;
		let exposure: string | undefined;
		let bearerEnv: string | undefined;
		const envList: string[] = [];
		const headerList: string[] = [];
		const positionals: string[] = [];

		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (arg === "--") {
				positionals.push(...rest.slice(i + 1));
				break;
			}
			if (arg === "-l" || arg === "--local") {
				local = true;
				continue;
			}
			if (arg === "--config") {
				jsonConfig = JSON.parse(rest[++i] ?? "");
				continue;
			}
			if (arg === "--url") {
				url = rest[++i];
				if (!url) throw agentCliErrors.invalidArgument("--url requires a value");
				continue;
			}
			if (arg.startsWith("--url=")) {
				url = arg.slice("--url=".length);
				continue;
			}
			if (arg === "--cwd") {
				cwd = rest[++i];
				if (!cwd) throw agentCliErrors.invalidArgument("--cwd requires a value");
				continue;
			}
			if (arg === "--description") {
				description = rest[++i];
				if (description === undefined) throw agentCliErrors.invalidArgument("--description requires a value");
				continue;
			}
			if (arg === "--exposure") {
				exposure = rest[++i];
				if (!exposure) throw agentCliErrors.invalidArgument("--exposure requires a value");
				continue;
			}
			if (arg === "--bearer-token-env-var") {
				bearerEnv = rest[++i];
				if (!bearerEnv) throw agentCliErrors.invalidArgument("--bearer-token-env-var requires a value");
				continue;
			}
			if (arg === "--env") {
				const v = rest[++i];
				if (!v) throw agentCliErrors.invalidArgument("--env requires KEY=VALUE");
				envList.push(v);
				continue;
			}
			if (arg.startsWith("--env=")) {
				envList.push(arg.slice("--env=".length));
				continue;
			}
			if (arg === "--header") {
				const v = rest[++i];
				if (!v) throw agentCliErrors.invalidArgument("--header requires a value");
				headerList.push(v);
				continue;
			}
			if (arg.startsWith("--header=")) {
				headerList.push(arg.slice("--header=".length));
				continue;
			}
			if (arg.startsWith("-")) {
				if (positionals.length >= 2) {
					positionals.push(...rest.slice(i));
					break;
				}
				throw agentCliErrors.invalidArgument(`unknown option ${arg}`);
			}
			positionals.push(arg);
		}

		const [name, ...cmd] = positionals;
		if (!name) {
			throw agentCliErrors.invalidArgument(
				"missing server name",
				"_agentcli server add <name> -- <command...> | _agentcli server add <name> --url <http-url>",
			);
		}
		if (url && cmd.length > 0) {
			throw agentCliErrors.invalidArgument("--url and a command are mutually exclusive");
		}
		if (jsonConfig === undefined && !url && cmd.length === 0) {
			throw agentCliErrors.invalidArgument(
				"a stdio server needs a command (or pass --url for HTTP)",
				"_agentcli server add <name> -- <command...> | _agentcli server add <name> --url <http-url>",
			);
		}

		let rawConfig: Record<string, unknown>;
		if (url) {
			const headers = parseKeyValuePairs(headerList, "header", true);
			if (bearerEnv) headers.Authorization = `Bearer \${${bearerEnv}}`;
			rawConfig = {
				url,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			};
		} else {
			const [command, ...args] = cmd;
			const env = parseKeyValuePairs(envList, "env", false);
			rawConfig = {
				command: command!,
				...(args.length > 0 ? { args } : {}),
				...(Object.keys(env).length > 0 ? { env } : {}),
				...(cwd ? { cwd } : {}),
			};
		}
		if (description) rawConfig.description = description;
		if (exposure) rawConfig.exposure = exposure;

		const validated = validateMcpServerConfig(name, jsonConfig ?? rawConfig);
		if (typeof validated === "string") {
			throw agentCliErrors.invalidArgument(validated);
		}
		const { path, replaced } = await host.addServer(name, validated, { local, cwd: ctx?.cwd ?? process.cwd() });
		return JSON.stringify({ ok: true, server: name, replaced, config: path }, null, 2);
	}

	if (sub === "remove") {
		const local = rest.includes("-l") || rest.includes("--local");
		const name = rest.find((t) => !t.startsWith("-"));
		if (!name) {
			throw agentCliErrors.invalidArgument("missing server name", "Usage: _agentcli server remove <name> [-l]");
		}
		const { path, removed } = await host.removeServer(name, { local, cwd: ctx?.cwd ?? process.cwd() });
		if (!removed) {
			throw agentCliErrors.notFound(`server "${name}" is not defined in ${path}`);
		}
		return JSON.stringify({ ok: true, removed: name, config: path }, null, 2);
	}

	throw agentCliErrors.notFound(
		`unknown server subcommand "${sub}"`,
		"Available: list, tools, add, remove",
	);
}

// ============================================================================
// Server connection lookup & error mapping
// ============================================================================

async function requireConnectedServer(
	host: AgentCliHost,
	serverName: string,
	refresh: boolean,
	signal: AbortSignal | undefined,
): Promise<AgentCliServerView> {
	const server = await host.waitForServer(serverName, signal);
	if (!server) {
		const names = host.getServers().map((s) => s.entry.name);
		const near = suggest(serverName, names);
		const hints: string[] = [];
		if (near.length) hints.push(`Did you mean: ${near.join(", ")}?`);
		hints.push(
			names.length
				? `Configured servers: ${names.join(", ")}`
				: "No servers configured — _agentcli server add <name> -- <command...>",
		);
		throw agentCliErrors.notFound(`unknown server "${serverName}"`, hints.join(" | "));
	}
	if (!isEnabled(server)) {
		throw agentCliErrors.connect(`MCP server "${serverName}" is disabled`, {
			hint: "Enable it with `/mcp` or in mcp.json",
		});
	}
	const conn = server.connection;
	if (!conn) {
		throw agentCliErrors.connect(`MCP server "${serverName}" is not connected`);
	}
	if (conn.state === "needs-auth") {
		throw agentCliErrors.auth(
			`MCP server "${serverName}" requires sign-in`,
			serverName,
		);
	}
	if (conn.state !== "connected") {
		try {
			await conn.getClient();
		} catch (e) {
			throw mapConnectionError(e, serverName, conn);
		}
	} else if (refresh) {
		try {
			await conn.refreshToolList();
		} catch (e) {
			throw mapConnectionError(e, serverName, conn);
		}
	}
	return server;
}

function mapConnectionError(e: unknown, serverName: string, conn?: McpServerConnection): AgentCliError {
	if (e instanceof AgentCliError) return e;
	if (conn?.state === "needs-auth") {
		return agentCliErrors.auth(`MCP server "${serverName}" requires sign-in`, serverName);
	}
	const msg = e instanceof Error ? e.message : String(e);
	if (/timed?\s*out/i.test(msg)) return agentCliErrors.timeout(`${serverName}: ${msg}`);
	if (/requires sign-in|authentication|unauthorized|401/i.test(msg)) {
		return agentCliErrors.auth(`${serverName}: ${msg}`, serverName);
	}
	return agentCliErrors.connect(`${serverName}: ${msg}`);
}

// ============================================================================
// Resource commands: `_agentcli <server> resources | templates | resource <uri>`
// ============================================================================

async function handleResourceCommand(
	server: AgentCliServerView,
	kind: "resources" | "templates" | "resource",
	rest: string[],
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<any>> {
	const conn = server.connection!;
	const serverName = server.entry.name;
	if (!conn.hasResources) {
		throw agentCliErrors.notFound(`MCP server "${serverName}" does not offer resources`);
	}
	if (kind === "resources" || kind === "templates") {
		let cursor: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "--cursor") cursor = rest[++i];
			else if (rest[i]?.startsWith("--cursor=")) cursor = rest[i]!.slice("--cursor=".length);
		}
		if (kind === "resources") {
			const page = cursor
				? await conn.resourcesPage(cursor, { signal, timeoutMs: conn.timeoutMs })
				: { resources: await conn.allResources({ signal, timeoutMs: conn.timeoutMs }) };
			const payload = {
				ok: true,
				server: serverName,
				data: {
					resources: page.resources,
					...("nextCursor" in page && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
				},
			};
			const { content, fullOutputPath } = await limitTextOutput(JSON.stringify(payload, null, 2));
			return {
				content,
				details: { server: serverName, tool: "resources", ...(fullOutputPath ? { fullOutputPath } : {}) },
			};
		}
		const page = cursor
			? await conn.resourceTemplatesPage(cursor, { signal, timeoutMs: conn.timeoutMs })
			: { resourceTemplates: await conn.allResourceTemplates({ signal, timeoutMs: conn.timeoutMs }) };
		const payload = {
			ok: true,
			server: serverName,
			data: {
				resourceTemplates: page.resourceTemplates,
				...("nextCursor" in page && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			},
		};
		const { content, fullOutputPath } = await limitTextOutput(JSON.stringify(payload, null, 2));
		return {
			content,
			details: { server: serverName, tool: "templates", ...(fullOutputPath ? { fullOutputPath } : {}) },
		};
	}

	// kind === "resource"
	const uri = rest.find((t) => !t.startsWith("-"));
	if (!uri) {
		throw agentCliErrors.invalidArgument(
			"missing resource URI",
			`Usage: _agentcli ${serverName} resource <uri>`,
		);
	}
	const result = await conn.readResource(uri, { signal, timeoutMs: conn.timeoutMs });
	const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
		...(result.contents.length > 1 ? [{ type: "text" as const, text: `${contents.uri}:` }] : []),
		{ type: "resource" as const, resource: contents },
	]);
	const converted = (await Promise.all(blocks.map((b) => blockToModelContent(serverName, b, true)))).flat();
	const textPart = converted
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const images = converted.filter((b): b is ImageContent => b.type === "image");
	const { content, fullOutputPath } = await limitTextOutput(
		textPart || `Resource ${uri} is empty.`,
		images,
	);
	return {
		content,
		details: { server: serverName, tool: "resource", uri, ...(fullOutputPath ? { fullOutputPath } : {}) },
	};
}

// ============================================================================
// BuiltinCommandDefinition factory
// ============================================================================

export function createAgentCliBuiltinCommand(host: AgentCliHost): BuiltinCommandDefinition {
	return {
		name: "_agentcli",
		description: "Discover and execute tools from configured MCP servers via progressive CLI disclosure.",
		get help() {
			return renderTopLevelHelp(host);
		},
		parseArguments(args: string[], heredoc?: string) {
			return { tokens: args, ...(heredoc !== undefined ? { heredoc } : {}) };
		},
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<any>> {
			const tokens = (params.tokens as string[] | undefined) ?? [];
			const heredoc = params.heredoc as string | undefined;

			try {
				host.refreshConfig?.(ctx);
				if (tokens.length === 0 || tokens[0] === "-h" || tokens[0] === "--help" || tokens[0] === "help") {
					return {
						content: [{ type: "text", text: renderTopLevelHelp(host) }],
						details: undefined,
					};
				}

				const first = tokens[0]!;
				if (first === "version" || first === "--version" || first === "-v") {
					return {
						content: [{ type: "text", text: "agentcli (pizza built-in)" }],
						details: undefined,
					};
				}

				if (first === "server") {
					const out = await handleServerSubcommand(host, tokens.slice(1), ctx, signal);
					return {
						content: [{ type: "text", text: out }],
						details: undefined,
					};
				}

				const serverName = first;
				const tail = tokens.slice(1);
				const wantsRefresh = tail.includes("--refresh");

				const server = await requireConnectedServer(host, serverName, wantsRefresh, signal);
				const conn = server.connection!;
				const tools = visibleTools(server);

				// 1. Server-level help: `_agentcli <server>` or `_agentcli <server> -h|--help`
				if (tail.length === 0 || tail[0] === "-h" || tail[0] === "--help" || tail[0] === "help") {
					return {
						content: [{ type: "text", text: renderServerHelp(server) }],
						details: undefined,
					};
				}

				const toolName = tail[0]!;
				if (toolName.startsWith("-")) {
					throw agentCliErrors.invalidArgument(
						`expected a tool name after "${serverName}", got "${toolName}"`,
						`_agentcli ${serverName} --help lists tools`,
					);
				}
				const rest = tail.slice(1);

				// Built-in resource subcommands when no tool has the same name
				if (
					(toolName === "resources" || toolName === "templates" || toolName === "resource") &&
					!tools.some((t) => t.name === toolName) &&
					conn.hasResources
				) {
					return await handleResourceCommand(server, toolName, rest, signal);
				}

				// 2. Find tool definition
				const tool = tools.find((t) => t.name === toolName);
				if (!tool) {
					const similar = suggest(
						toolName,
						tools.map((t) => t.name),
					).slice(0, 5);
					const hints: string[] = [];
					if (similar.length) hints.push(`Similar tools: ${similar.join(", ")}`);
					hints.push(`List tools: _agentcli ${serverName} --help`);
					throw agentCliErrors.notFound(
						`tool "${toolName}" not found on server "${serverName}"`,
						hints.join(" | "),
					);
				}

				const wantsHelp = rest.includes("--help") || rest.includes("-h");
				const wantsSchema = rest.includes("--schema");

				if (wantsHelp) {
					return {
						content: [{ type: "text", text: renderToolHelp(serverName, tool) }],
						details: undefined,
					};
				}
				if (wantsSchema) {
					return {
						content: [{ type: "text", text: JSON.stringify(tool.inputSchema ?? { type: "object" }, null, 2) }],
						details: undefined,
					};
				}

				// 3. Parse flags against the schema plan, merge with --input
				const plan = buildFlagPlan(tool.inputSchema);
				const { args: flagArgs, opts } = parseToolArgs(plan, rest, heredoc);
				let callArgs = flagArgs;
				if (opts.input !== undefined) {
					const inputObj = readInputJson(opts.input as string, ctx?.cwd ?? process.cwd());
					callArgs = { ...inputObj, ...flagArgs };
				}
				validateRequired(plan, callArgs);

				const outputFormat = (opts.output as string | undefined) || "json";
				if (outputFormat !== "json" && outputFormat !== "text") {
					throw agentCliErrors.invalidArgument(`invalid --output "${outputFormat}"`, "Supported: json, text");
				}

				const timeoutMs = opts["timeout-ms"] !== undefined ? Number(opts["timeout-ms"]) : conn.timeoutMs;
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
					throw agentCliErrors.invalidArgument(
						"invalid --timeout-ms",
						"Must be a positive number of milliseconds",
					);
				}

				// 4. Execute tool call
				const started = Date.now();
				let mcpResult: CallToolResult;
				try {
					mcpResult = await conn.callTool(toolName, callArgs, {
						signal,
						timeoutMs,
						onProgress: (progress) => {
							const total = progress.total === undefined ? "" : `/${progress.total}`;
							const text = progress.message ?? `Progress ${progress.progress}${total}`;
							onUpdate?.({
								content: [{ type: "text", text }],
								details: { server: serverName, tool: toolName },
							});
						},
					});
				} catch (e) {
					throw mapConnectionError(e, serverName, conn);
				}

				const { data, text: rawText, isError } = extractResultData(mcpResult);
				if (isError) {
					throw agentCliErrors.execution(
						rawText || (data !== null && data !== undefined ? JSON.stringify(data) : "tool reported an error"),
					);
				}

				// Collect any image/binary blocks from the MCP response
				const modelBlocks = (
					await Promise.all(
						(mcpResult.content ?? []).map((b) => blockToModelContent(serverName, b, conn.hasResources)),
					)
				).flat();
				const images = modelBlocks.filter((b): b is ImageContent => b.type === "image");
				const resourceNotes = (mcpResult.content ?? [])
					.map((b, idx) => (b.type === "resource_link" || b.type === "resource" ? modelBlocks[idx] : undefined))
					.filter((b): b is TextContent => Boolean(b && b.type === "text"));

				// 5. Observe output
				let outputText: string;
				if (outputFormat === "text") {
					outputText =
						data !== null && typeof data === "object"
							? JSON.stringify(data, null, 2)
							: (rawText ?? JSON.stringify(data));
					if (resourceNotes.length > 0 && !rawText) {
						outputText = [outputText, ...resourceNotes.map((n) => n.text)].filter(Boolean).join("\n");
					}
				} else {
					const envelope = {
						ok: true,
						server: serverName,
						tool: toolName,
						data,
						meta: {
							durationMs: Date.now() - started,
							via: "daemon",
						},
					};
					outputText = JSON.stringify(envelope, null, 2);
				}

				const { content, fullOutputPath } = await limitTextOutput(outputText, images);
				return {
					content,
					details: {
						server: serverName,
						tool: toolName,
						...(fullOutputPath ? { fullOutputPath } : {}),
					},
				};
			} catch (err) {
				const cliErr =
					err instanceof AgentCliError
						? err
						: new AgentCliError("INTERNAL", err instanceof Error ? err.message : String(err));
				return {
					content: [{ type: "text", text: formatErrorEnvelope(cliErr) }],
					details: { error: cliErr.code },
				};
			}
		},
	};
}
