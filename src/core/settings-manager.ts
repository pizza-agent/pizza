import type { CacheRetention, Transport } from "@earendil-works/pi-ai/compat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { ConfigFileVersionTracker } from "./config-file-version.js";
import { homedir } from "os";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import {
	BUILTIN_EXTENSION_SOURCE,
	type ExtensionRecord,
	ExtensionRegistry,
	packageSourceToRecord,
	recordToPackageSource,
	withPackageFilters,
} from "./extension-registry.js";

/** File name of the plugin registry inside the agent dir. */
export const EXTENSION_REGISTRY_FILE = "extensions.json";
import type { NetworkSettings, SchedulerPolicy } from "@tomsun28/pizza-protocol";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

/**
 * Per-category approval gates. These only take effect when `safeMode` is
 * `"auto"` (the default when unset) — with `safeMode: true` every risky call
 * is gated, and with an explicit `safeMode: false` nothing is gated.
 */
export interface ApprovalSettings {
	writes?: boolean; // default: true  - approve before file writes
	edits?: boolean; // default: true  - approve before file edits
	shellModerate?: boolean; // default: false - approve before ordinary shell commands
	unknown?: boolean; // default: true  - approve before unrecognized tools
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export type TransportSetting = Transport;

/**
 * Global prompt cache retention default. Per-provider/per-model
 * `cacheRetention` in models.json takes precedence over this.
 */
export type CacheRetentionSetting = CacheRetention;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/**
 * The thinking levels that can be persisted to settings.json. This is a strict
 * subset of the runtime `ThinkingLevel` (pi-ai adds e.g. "max", and the runtime
 * itself accepts arbitrary strings), so callers must narrow with
 * {@link isPersistableThinkingLevel} before writing.
 */
export type PersistableThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PERSISTABLE_THINKING_LEVELS: readonly PersistableThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export function isPersistableThinkingLevel(level: string): level is PersistableThinkingLevel {
	return (PERSISTABLE_THINKING_LEVELS as readonly string[]).includes(level);
}

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: PersistableThinkingLevel;
	transport?: TransportSetting; // default: "sse"
	// Prompt cache retention default. Unset means pi-ai's own default ("short").
	// Set to "none" for relay gateways that reject cache_control requests.
	cacheRetention?: CacheRetentionSetting;
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	// Master toggle for tool approval. Default: false.
	//   true   - every risky tool call requires explicit approval
	//   false  - nothing is gated; tools auto-run
	//   "auto" - defer to the per-category `approvals` gates below
	safeMode?: boolean | "auto";
	approvals?: ApprovalSettings; // per-category gates; only consulted when safeMode is "auto"
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	// Automatic update check against the npm registry / GitHub releases on
	// interactive startup (cached 24h). Default: true.
	autoUpdateCheck?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	/** @deprecated Migrated into extensions.json (see ExtensionRegistry) on load; use getPackages/setPackages. */
	packages?: PackageSource[];
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	/** @deprecated Migrated into extensions.json (see ExtensionRegistry) on load; use setBuiltinExtensionDisabled. */
	disabledBuiltinExtensions?: string[];
	enabledBuiltinSkills?: string[]; // Built-in skill ids to enable (e.g. ["pizza-self-optimization"]). Empty/absent = all built-in skills DISABLED by default.
	disabledSkills?: string[]; // Names of discovered (non-built-in) skills to disable. Empty/absent = every discovered skill is loaded.
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	scheduler?: SchedulerPolicy; // Defaults applied to newly-created scheduled tasks
	network?: NetworkSettings; // Outbound proxy for channel adapters etc. ("auto" | "off" | URL)
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	/**
	 * Path backing a scope, when the storage is file-backed.
	 *
	 * Optional on purpose: in-memory storage has no file to watch, and returning
	 * undefined disables change detection instead of forcing a fake path.
	 */
	getPath?(scope: SettingsScope): string | undefined;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	}

	getPath(scope: SettingsScope): string {
		return scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	/** Merged view of global + project + overrides; read through the `settings` getter. */
	private mergedSettings: Settings = {};
	/** CLI/runtime overrides, reapplied after every reload so edits cannot drop them. */
	private overrides: Partial<Settings> | undefined;
	private versions = new ConfigFileVersionTracker();
	private reloading = false;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	/** Installed/enabled state of every plugin (built-ins and packages) — `extensions.json`. */
	readonly extensions: ExtensionRegistry;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		extensions: ExtensionRegistry = ExtensionRegistry.inMemory(),
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.extensions = extensions;
		this.absorbLegacyExtensionSettings();
		this.recomputeMerged();
		this.recordVersion("global");
		this.recordVersion("project");
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, ExtensionRegistry.file(join(agentDir, EXTENSION_REGISTRY_FILE)));
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, extensions?: ExtensionRegistry): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			extensions,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		return new SettingsManager(storage, settings, {});
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		this.reloading = true;
		try {
			this.reloadScope("global");

			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			this.modifiedProjectFields.clear();
			this.modifiedProjectNestedFields.clear();

			this.reloadScope("project");
			this.recomputeMerged();
		} finally {
			this.reloading = false;
		}
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		// Overrides are kept as their own layer instead of being folded into the
		// merged snapshot: a hot reload rebuilds the merge from disk, and CLI
		// overrides must outlive that rebuild.
		this.overrides = this.overrides ? deepMergeSettings(this.overrides, overrides) : overrides;
		this.recomputeMerged();
	}

	/** Rebuild the merged view from its layers: global < project < overrides. */
	private recomputeMerged(): void {
		const base = deepMergeSettings(this.globalSettings, this.projectSettings);
		this.mergedSettings = this.overrides ? deepMergeSettings(base, this.overrides) : base;
	}

	private recordVersion(scope: SettingsScope): void {
		this.versions.record(scope, this.storage.getPath?.(scope));
	}

	/** Load one scope from storage, keeping the last good values if it fails to parse. */
	private reloadScope(scope: SettingsScope): void {
		const load = SettingsManager.tryLoadFromStorage(this.storage, scope);
		this.recordVersion(scope);

		if (load.error) {
			// A half-written or malformed file must not wipe working settings:
			// record the error and keep serving what we already had.
			if (scope === "global") {
				this.globalSettingsLoadError = load.error;
			} else {
				this.projectSettingsLoadError = load.error;
			}
			this.recordError(scope, load.error);
			return;
		}

		if (scope === "global") {
			this.globalSettings = load.settings;
			this.globalSettingsLoadError = null;
			this.absorbLegacyExtensionSettings();
		} else {
			this.projectSettings = load.settings;
			this.projectSettingsLoadError = null;
		}
	}

	/**
	 * The merged settings every getter reads. Each access first checks whether
	 * settings.json changed on disk, so hand edits — or writes from another
	 * running instance — take effect without a restart.
	 */
	private get settings(): Settings {
		this.reloadIfChanged();
		return this.mergedSettings;
	}

	private set settings(value: Settings) {
		this.mergedSettings = value;
	}

	/**
	 * Reload the scopes whose file changed since we last read or wrote it.
	 *
	 * Skipped while a save is pending: those in-memory edits have not reached
	 * disk yet, so reloading would resurrect the old values and lose them.
	 */
	private reloadIfChanged(): void {
		if (this.reloading) return;
		if (!this.storage.getPath) return; // non-file storage has nothing to watch
		if (this.modifiedFields.size > 0 || this.modifiedProjectFields.size > 0) return;

		const scopes: SettingsScope[] = ["global", "project"];
		const stale = scopes.filter((scope) => this.versions.hasChanged(scope, this.storage.getPath?.(scope)));
		if (stale.length === 0) return;

		this.reloading = true;
		try {
			for (const scope of stale) {
				this.reloadScope(scope);
			}
			this.recomputeMerged();
		} finally {
			this.reloading = false;
		}
	}

	/**
	 * Move the legacy `packages` / `disabledBuiltinExtensions` keys of the user
	 * settings.json into extensions.json, then drop them from settings.json.
	 * Runs on every (re)load so a hand-edited legacy key is still honored once.
	 * Existing registry records win over legacy values.
	 */
	private absorbLegacyExtensionSettings(): void {
		if (this.globalSettingsLoadError) return;
		const { packages, disabledBuiltinExtensions } = this.globalSettings;
		if (packages === undefined && disabledBuiltinExtensions === undefined) return;
		try {
			this.extensions.mutate((extensions) => {
				for (const id of disabledBuiltinExtensions ?? []) {
					extensions[id] ??= { source: BUILTIN_EXTENSION_SOURCE, enabled: false };
				}
				for (const pkg of packages ?? []) {
					const record = packageSourceToRecord(pkg);
					extensions[record.source] ??= record;
				}
			});
		} catch (error) {
			// Corrupt extensions.json: keep the legacy keys so nothing is lost.
			this.recordError("global", error);
			return;
		}
		this.globalSettings.packages = undefined;
		this.globalSettings.disabledBuiltinExtensions = undefined;
		this.markModified("packages");
		this.markModified("disabledBuiltinExtensions");
		this.save();
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
				// Record our own write so the next read does not mistake it for an
				// external edit and reload needlessly.
				this.recordVersion(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.recomputeMerged();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.recomputeMerged();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		if (!sessionDir) {
			return sessionDir;
		}
		if (sessionDir === "~") {
			return homedir();
		}
		if (sessionDir.startsWith("~/")) {
			return join(homedir(), sessionDir.slice(2));
		}
		return sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): PersistableThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: PersistableThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "sse";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	/** Undefined means "not configured" so pi-ai keeps its own default. */
	getCacheRetention(): CacheRetentionSetting | undefined {
		return this.settings.cacheRetention;
	}

	setCacheRetention(retention: CacheRetentionSetting): void {
		this.globalSettings.cacheRetention = retention;
		this.markModified("cacheRetention");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
			maxDelayMs: this.settings.retry?.maxDelayMs ?? 60000,
		};
	}

	/**
	 * Whether safe mode is explicitly ON. `"auto"` reports false here because the
	 * UI toggle is binary — use {@link getSafeModeSetting} to read the raw value.
	 */
	getSafeMode(): boolean {
		return this.settings.safeMode === true;
	}

	/**
	 * Raw tri-state safe-mode setting: `true` | `false` | `undefined`.
	 * `"auto"` maps to `undefined`, which tells the classifier to fall back to the
	 * per-category `approvals` gates instead of forcing a blanket answer.
	 *
	 * DEFAULT CHANGED (security): an unset safeMode now defaults to "auto"
	 * (per-category gates: writes/edits/unknown gated, moderate shell auto-runs)
	 * instead of false (everything auto-runs, including dangerous shell).
	 * The old default disabled approval for ALL risk levels — combined with
	 * prompt-injection surfaces (tell, cron, file content) that was an
	 * unauthenticated command-execution chain. Explicit `safeMode: false` in
	 * settings.json still means what it says — only the unset default moved.
	 * Headless callers that need the old behavior pass an explicit default via
	 * {@link getSafeModeSettingWithDefault}.
	 */
	getSafeModeSetting(): boolean | undefined {
		return this.getSafeModeSettingWithDefault("auto");
	}

	/**
	 * Like {@link getSafeModeSetting} but with a caller-chosen default for when
	 * settings.json does not set safeMode. Modes without an approval UI (print)
	 * pass `false` to keep one-shot automation runnable; interactive/GUI/rpc
	 * use the "auto" default.
	 */
	getSafeModeSettingWithDefault(defaultValue: boolean | "auto"): boolean | undefined {
		const value = this.settings.safeMode ?? defaultValue;
		return value === "auto" ? undefined : value;
	}

	/** Per-category approval gates; only consulted when safeMode is `"auto"`. */
	getApprovalSettings(): {
		writes: boolean;
		edits: boolean;
		shellModerate: boolean;
		unknown: boolean;
	} {
		const approvals = this.settings.approvals;
		// Default "gated" policy: unknown tools + dangerous shell are gated
		// (dangerous is always gated by the classifier); writes/edits/ordinary
		// shell auto-run.
		return {
			writes: approvals?.writes ?? false,
			edits: approvals?.edits ?? false,
			shellModerate: approvals?.shellModerate ?? false,
			unknown: approvals?.unknown ?? true,
		};
	}

	setSafeMode(enabled: boolean | "auto"): void {
		this.globalSettings.safeMode = enabled;
		this.markModified("safeMode");
		this.save();
	}

	/** Persist per-category approval gates (merged into global settings). */
	setApprovalGates(gates: Partial<ApprovalSettings>): void {
		this.globalSettings.approvals = { ...this.globalSettings.approvals, ...gates };
		this.markModified("approvals");
		this.save();
	}

	/**
	 * Scheduler defaults applied to newly-created scheduled tasks. Tasks
	 * can still override per-task; this is the fallback when a task does
	 * not specify concurrencyPolicy / timeoutMinutes / sessionTarget.
	 */
	getSchedulerPolicy(): SchedulerPolicy {
		return this.globalSettings.scheduler ?? {
			concurrency: "skip",
			timeoutMinutes: 0,
			defaultSessionTarget: { kind: "pinned" },
		};
	}

	setSchedulerPolicy(policy: SchedulerPolicy): void {
		this.globalSettings.scheduler = policy;
		this.markModified("scheduler");
		this.save();
	}

	getNetworkSettings(): NetworkSettings {
		return this.globalSettings.network ?? {};
	}

	setNetworkSettings(network: NetworkSettings): void {
		const proxy = network.proxy?.trim() || "auto";
		this.globalSettings.network = { ...this.globalSettings.network, proxy };
		this.markModified("network");
		this.save();
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getAutoUpdateCheck(): boolean {
		return this.settings.autoUpdateCheck ?? true;
	}

	setAutoUpdateCheck(enabled: boolean): void {
		this.globalSettings.autoUpdateCheck = enabled;
		this.markModified("autoUpdateCheck");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	/** Installed plugin packages (enabled or not), in load order, from extensions.json. */
	getPackages(): PackageSource[] {
		return this.extensions.listPackages().map(([, record]) => recordToPackageSource(record));
	}

	/**
	 * Replace the set of installed plugin packages. Packages that stay keep
	 * their recorded state (enabled, version, path); their resource filters
	 * are replaced. Built-in records are untouched.
	 */
	setPackages(packages: PackageSource[]): void {
		this.extensions.mutate((extensions) => {
			const next: Record<string, ExtensionRecord> = {};
			for (const [id, record] of Object.entries(extensions)) {
				if (record.source === BUILTIN_EXTENSION_SOURCE) next[id] = record;
			}
			for (const pkg of packages) {
				const fresh = packageSourceToRecord(pkg);
				const previous = extensions[fresh.source];
				next[fresh.source] = previous ? withPackageFilters(previous, pkg) : fresh;
			}
			return next;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.extensions = paths;
		this.markProjectModified("extensions");
		this.saveProjectSettings(projectSettings);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.skills = paths;
		this.markProjectModified("skills");
		this.saveProjectSettings(projectSettings);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.prompts = paths;
		this.markProjectModified("prompts");
		this.saveProjectSettings(projectSettings);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.themes = paths;
		this.markProjectModified("themes");
		this.saveProjectSettings(projectSettings);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	/** Return the set of built-in extension ids the user has disabled. */
	getDisabledBuiltinExtensions(): Set<string> {
		const disabled = new Set<string>();
		for (const [id, record] of Object.entries(this.extensions.list())) {
			if (record.source === BUILTIN_EXTENSION_SOURCE && !record.enabled) disabled.add(id);
		}
		return disabled;
	}

	/** Disable (true) or enable (false) a built-in extension by id, persisted to extensions.json. */
	setBuiltinExtensionDisabled(id: string, disabled: boolean): void {
		this.extensions.patch(id, { enabled: !disabled }, { source: BUILTIN_EXTENSION_SOURCE, enabled: true });
	}

	/** Return the set of built-in skill ids the user has explicitly enabled. */
	getEnabledBuiltinSkills(): Set<string> {
		return new Set(this.settings.enabledBuiltinSkills ?? []);
	}

	/** Enable (true) or disable (false) a built-in skill by id, persisted to user settings. */
	setBuiltinSkillEnabled(id: string, enabled: boolean): void {
		const current = new Set(this.settings.enabledBuiltinSkills ?? []);
		if (enabled) {
			current.add(id);
		} else {
			current.delete(id);
		}
		const arr = Array.from(current);
		this.globalSettings.enabledBuiltinSkills = arr.length > 0 ? arr : undefined;
		this.markModified("enabledBuiltinSkills");
		this.save();
	}

	/**
	 * Names of discovered skills the user has turned off. Discovered skills are
	 * enabled by default, so this is a denylist (the mirror image of the
	 * built-in skill allowlist).
	 */
	getDisabledSkills(): Set<string> {
		return new Set(this.settings.disabledSkills ?? []);
	}

	/** Disable (true) or enable (false) a discovered skill by name, persisted to user settings. */
	setSkillDisabled(name: string, disabled: boolean): void {
		const current = new Set(this.settings.disabledSkills ?? []);
		if (disabled) {
			current.add(name);
		} else {
			current.delete(name);
		}
		const arr = Array.from(current);
		this.globalSettings.disabledSkills = arr.length > 0 ? arr : undefined;
		this.markModified("disabledSkills");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PIZZA_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PIZZA_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}
}
