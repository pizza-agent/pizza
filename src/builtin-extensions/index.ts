/**
 * Built-in extensions registry.
 *
 * Built-in extensions ship with Pizza and are enabled by default. They behave
 * exactly like user extensions (loaded via the same `ExtensionFactory` path)
 * but are always present unless the user explicitly disables one in
 * `settings.json` under `disabledBuiltinExtensions`.
 *
 * To add a new built-in extension:
 * 1. Create a folder under `src/builtin-extensions/<id>/` exporting an `ExtensionFactory`.
 * 2. Register it in `BUILTIN_EXTENSIONS` below with a stable id.
 */

import type { ExtensionFactory } from "../core/extensions/types.js";
import {
	AGENT_BROWSER_EXTENSION_ID,
	checkBrowserAvailable,
	createAgentBrowserExtension,
	runAgentBrowserInstall,
	runAgentBrowserUninstall,
} from "./agent-browser/index.js";
import {
	COMPUTER_USE_EXTENSION_ID,
	checkComputerUseInstalled,
	createComputerUseExtension,
	getComputerUsePermissionStatus,
	openComputerUsePermissionSettings,
	recheckComputerUsePermissionStatus,
	runComputerUseInstall,
	runComputerUseUninstall,
} from "./computer-use/index.js";

/** Result of an install/uninstall lifecycle action. */
export interface ExtensionLifecycleResult {
	ok: boolean;
	message: string;
}

/** Result of checking whether an extension's external dependency is installed. */
export interface ExtensionInstallState {
	installed: boolean;
	version?: string;
}

export type ExtensionPermissionKind = "accessibility" | "screenRecording";

export interface ExtensionPermissionInfo {
	kind: ExtensionPermissionKind;
	label: string;
	description: string;
	granted: boolean;
	required: boolean;
}

export interface ExtensionPermissionState {
	supported: boolean;
	installed: boolean;
	ready: boolean;
	helperPath?: string;
	message?: string;
	permissions: ExtensionPermissionInfo[];
}

export interface BuiltinExtension {
	/** Stable id used in `settings.disabledBuiltinExtensions`. */
	id: string;
	/** Human-readable name shown in UI. Defaults to the id. */
	name: string;
	/** Short, human-readable description shown in UI. */
	description: string;
	/** Factory that registers tools, commands, and event handlers. */
	factory: ExtensionFactory;
	/** Whether this built-in ships an external dependency that can be installed/uninstalled (e.g. a CLI binary). */
	installable?: boolean;
	/** Check whether the external dependency is installed. Only when installable. */
	checkInstalled?: (cwd: string) => Promise<ExtensionInstallState>;
	/** Install the external dependency. Only when installable. */
	install?: (cwd: string) => Promise<ExtensionLifecycleResult>;
	/** Uninstall the external dependency. Only when installable. */
	uninstall?: (cwd: string) => Promise<ExtensionLifecycleResult>;
	/** Check OS/application permissions needed by the extension's external dependency. */
	checkPermissions?: (cwd: string) => Promise<ExtensionPermissionState>;
	/** Recheck permissions after the user changes OS settings. */
	recheckPermissions?: (cwd: string) => Promise<ExtensionPermissionState>;
	/** Open the OS settings pane for a missing permission. */
	openPermissionSettings?: (cwd: string, kind: ExtensionPermissionKind) => Promise<ExtensionLifecycleResult>;
}

/**
 * All built-in extensions, in load order. Load order matters for command/tool
 * conflict precedence (earlier wins for diagnostics; both are kept).
 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
	{
		id: AGENT_BROWSER_EXTENSION_ID,
		name: "agent-browser",
		description: "Browser automation CLI for AI agents (Chrome/Chromium via CDP).",
		factory: createAgentBrowserExtension,
		installable: true,
		checkInstalled: (cwd) => checkBrowserAvailable(cwd),
		install: (cwd) => runAgentBrowserInstall(cwd),
		uninstall: (cwd) => runAgentBrowserUninstall(cwd),
	},
	{
		id: COMPUTER_USE_EXTENSION_ID,
		name: "computer-use",
		description: "Desktop app automation via structured UI observation (vendored pi-computer-use backend).",
		factory: createComputerUseExtension,
		installable: true,
		checkInstalled: (cwd) => checkComputerUseInstalled(cwd),
		install: (cwd) => runComputerUseInstall(cwd),
		uninstall: (cwd) => runComputerUseUninstall(cwd),
		checkPermissions: (cwd) => getComputerUsePermissionStatus(cwd),
		recheckPermissions: (cwd) => recheckComputerUsePermissionStatus(cwd),
		openPermissionSettings: (cwd, kind) => openComputerUsePermissionSettings(cwd, kind),
	},
];

/**
 * Return the built-in extensions (id + factory), excluding any disabled ids.
 */
export function getBuiltinExtensionFactories(
	disabledIds: ReadonlySet<string>,
): BuiltinExtension[] {
	return BUILTIN_EXTENSIONS.filter((ext) => !disabledIds.has(ext.id));
}

/** Lightweight info about every built-in extension (no factory), for UI / RPC. */
export interface BuiltinExtensionInfo {
	id: string;
	name: string;
	description: string;
}

/** All built-in extension ids (for diagnostics / UI). */
export function getBuiltinExtensionIds(): string[] {
	return BUILTIN_EXTENSIONS.map((ext) => ext.id);
}

/** Info (id/name/description) for every built-in extension, regardless of enabled state. */
export function getBuiltinExtensionInfos(): BuiltinExtensionInfo[] {
	return BUILTIN_EXTENSIONS.map((ext) => ({ id: ext.id, name: ext.name, description: ext.description }));
}

/** Look up info for a single built-in extension id. */
export function getBuiltinExtensionInfo(id: string): BuiltinExtensionInfo | undefined {
	return BUILTIN_EXTENSIONS.find((ext) => ext.id === id);
}


/** Look up the install lifecycle (install/uninstall/checkInstalled) for a built-in id. */
export function getBuiltinExtensionLifecycle(
	id: string,
): Pick<BuiltinExtension, "installable" | "checkInstalled" | "install" | "uninstall" | "checkPermissions" | "recheckPermissions" | "openPermissionSettings"> | undefined {
	const ext = BUILTIN_EXTENSIONS.find((e) => e.id === id);
	if (!ext) return undefined;
	return {
		installable: ext.installable,
		checkInstalled: ext.checkInstalled,
		install: ext.install,
		uninstall: ext.uninstall,
		checkPermissions: ext.checkPermissions,
		recheckPermissions: ext.recheckPermissions,
		openPermissionSettings: ext.openPermissionSettings,
	};
}
