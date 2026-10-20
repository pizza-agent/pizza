/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 * Uses @mariozechner/jiti fork with virtualModules support for compiled Bun binaries.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyId } from "@earendil-works/pi-tui";
// Bun-binary-only module payloads: in a compiled `bun build --compile` binary
// jiti cannot resolve node_modules, so these packages are bundled and handed to
// extensions via jiti virtualModules. They are imported lazily inside
// getVirtualModules() so Node.js consumers (CLI, SDK) never pay the import
// cost — under Node, jiti uses filesystem aliases instead.
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from "pizza".
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec/exec.js";
import { execCommand } from "../exec/exec.js";
import { createSyntheticSourceInfo } from "../skills/source-info.js";
import { type McpServerConfig, McpServerRegistry, mcpNamespace, validateMcpServerConfig } from "../mcp/servers.js";
import type {
	BuiltinCommandDefinition,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	ExtensionMenu,
	ExtensionSettingsItem,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.js";

/** Underscore tokens owned by the core static built-in commands; extensions must not shadow them. */
const STATIC_BUILTIN_TOKENS: ReadonlySet<string> = new Set([
	"_read",
	"_write",
	"_edit",
	"_session_split",
	"_history_tree",
	"_skill",
	"_cron",
	"_tell",
]);

/**
 * Validate a dynamic built-in command token: "_" + lowercase identifier
 * (letters/digits/underscore/hyphen), and never a collision with the static
 * built-in commands (_read, _write, ...).
 */
function validateBuiltinCommandName(name: string): void {
	if (!/^_[a-z][a-z0-9_-]*$/.test(name)) {
		throw new Error(
			`Invalid builtin command name: ${name}. Must be an underscore token like "_computer_use" (lowercase letters, digits, - or _).`,
		);
	}
	if (STATIC_BUILTIN_TOKENS.has(name.toLowerCase())) {
		throw new Error(`Builtin command name ${name.toLowerCase()} collides with a static built-in command.`);
	}
}

/**
 * Modules available to extensions via virtualModules (compiled Bun binary
 * only). Imported lazily: the whole point of virtualModules is to hand jiti
 * pre-bundled module objects when no node_modules exist, so loading them on
 * Node — where jiti uses filesystem aliases — is pure startup cost (pi-tui,
 * the pizza index self-import, typebox).
 */
let _virtualModules: Promise<Record<string, unknown>> | undefined;
function getVirtualModules(): Promise<Record<string, unknown>> {
	_virtualModules ??= Promise.all([
		import("@earendil-works/pi-tui"),
		import("@earendil-works/pi-ai/compat"),
		import("@sinclair/typebox"),
		import("../../index.js"),
	]).then(([_bundledTui, _bundledAi, _bundledTypebox, _bundledPizza]) => ({
		"@sinclair/typebox": _bundledTypebox,
		typebox: _bundledTypebox,
		"@earendil-works/pi-tui": _bundledTui,
		"@mariozechner/pi-tui": _bundledTui,
		"@earendil-works/pi-ai": _bundledAi,
		"@mariozechner/pi-ai": _bundledAi,
		pizza: _bundledPizza,
		"@earendil-works/pi-coding-agent": _bundledPizza,
		"@mariozechner/pi-coding-agent": _bundledPizza,
	}));
	return _virtualModules;
}

const require = createRequire(import.meta.url);

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;
function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	// Built package: dist/src/index.js. Source tree (vitest/dev): src/index.ts.
	const packageIndex = (() => {
		const distIndex = path.resolve(__dirname, "../..", "index.js");
		if (fs.existsSync(distIndex)) return distIndex;
		const srcIndex = path.resolve(__dirname, "../..", "index.ts");
		return fs.existsSync(srcIndex) ? srcIndex : distIndex;
	})();

	const typeboxEntry = require.resolve("@sinclair/typebox");
	const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		// Fallback for environments where import.meta.resolve is not available (e.g., vitest SSR)
		try {
			if (typeof import.meta.resolve === "function") {
				return fileURLToPath(import.meta.resolve(specifier));
			}
		} catch {
			// import.meta.resolve failed, try require.resolve
		}
		// Use require.resolve as fallback - handle ESM packages
		try {
			const resolved = require.resolve(specifier);
			return resolved;
		} catch {
			// If require.resolve fails, try resolving with explicit .js extension for ESM
			try {
				return require.resolve(specifier + "/dist/index.js");
			} catch {
				// Last resort: return the specifier as-is
				return specifier;
			}
		}
	};

	const piTui = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	const piAi = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");

	_aliases = {
		pizza: packageIndex,
		// Upstream pi specifiers resolve to pizza's own API entry point so
		// extensions published for pi (https://pi.dev/packages) load here too.
		"@earendil-works/pi-coding-agent": packageIndex,
		"@mariozechner/pi-coding-agent": packageIndex,
		"@earendil-works/pi-tui": piTui,
		"@mariozechner/pi-tui": piTui,
		"@earendil-works/pi-ai": piAi,
		"@mariozechner/pi-ai": piAi,
		"@sinclair/typebox": typeboxRoot,
		typebox: typeboxRoot,
	};

	return _aliases;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		mcpServers: new McpServerRegistry(),
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerBuiltinCommand(command: BuiltinCommandDefinition): void {
			runtime.assertActive();
			validateBuiltinCommandName(command.name);
			const name = command.name.toLowerCase();
			extension.builtinCommands.set(name, {
				...command,
				name,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerSettingsItem(item: ExtensionSettingsItem): void {
			runtime.assertActive();
			extension.settingsItems.set(item.id, { ...item, sourceInfo: extension.sourceInfo });
		},

		registerMenu(menu: ExtensionMenu): void {
			runtime.assertActive();
			extension.menus.set(menu.id, { ...menu, sourceInfo: extension.sourceInfo });
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		registerMcpServer(name: string, config: McpServerConfig) {
			runtime.assertActive();
			const validated = validateMcpServerConfig(name, config);
			if (typeof validated === "string") {
				throw new Error(`Invalid MCP server registered by extension "${extension.path}": ${validated}`);
			}
			const owner = runtime.mcpServers.get(name)?.extensionPath;
			if (owner !== undefined && owner !== extension.path) {
				throw new Error(`MCP server "${name}" is already registered by extension "${owner}"`);
			}
			const clash = runtime.mcpServers
				.list()
				.find((server) => server.name !== name && mcpNamespace(server.name) === mcpNamespace(name));
			if (clash) throw new Error(`MCP server "${name}" conflicts with registered server "${clash.name}"`);
			runtime.mcpServers.register({ name, config: structuredClone(validated), extensionPath: extension.path });
		},

		unregisterMcpServer(name: string) {
			runtime.assertActive();
			runtime.mcpServers.unregister(name, extension.path);
		},

		getMcpServers() {
			runtime.assertActive();
			return runtime.mcpServers.list();
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

async function loadExtensionModule(extensionPath: string) {
	// jiti is only needed to load user-supplied extension files — defer the
	// import so sessions without file-based extensions never pay for it.
	const { createJiti } = await import("@mariozechner/jiti");
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: await getVirtualModules(), tryNative: false } : { alias: getAliases() }),
		// Allow ESM imports without requiring main export
		interopDefault: true,
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		builtinCommands: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		settingsItems: new Map(),
		menus: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface PizzaManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readPizzaManifest(packageJsonPath: string): PizzaManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		// Accept "pi" as a fallback so packages published for the upstream pi
		// ecosystem (https://pi.dev/packages) resolve their extensions too.
		const manifest = pkg.pizza ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest as PizzaManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pizza.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check package.json manifest fields first.
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPizzaManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pizza" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/<CONFIG_DIR_NAME>/extensions/
	const localExtDir = path.join(cwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pizza manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
