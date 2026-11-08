export type RootSelector = string;
export type ImageMode = "auto" | "always" | "never";
export type MouseButtonName = "left" | "right" | "middle";

export interface ObserveTargetParams {
	root?: RootSelector;
}

export interface FindParams {
	text?: string;
	app?: string;
	bundleId?: string;
	pid?: number;
	/** Filters on the platform's best-effort presentation hint; only window vs transient is guaranteed. */
	kind?: "window" | "menu" | "sheet" | "popover" | "dialog";
}

export interface StateTargetParams {
	stateId?: string;
}

export interface ObserveParams extends ObserveTargetParams {
	mode?: "semantic" | "visual" | "fused";
	/** Internal capture override; not part of the model-facing schema. */
	readText?: "auto" | "always" | "never";
}

export interface SearchUiParams extends StateTargetParams {
	text?: string;
	role?: string;
	capability?: string;
}

export interface ExpandUiParams extends StateTargetParams {
	ref: string;
	depth?: number;
}

export interface InspectUiParams extends StateTargetParams {
	ref: string;
}

export interface UiCondition {
	ref?: string;
	scopeRef?: string;
	text?: string;
	role?: string;
	value?: string;
	until?: "present" | "absent";
	timeoutMs?: number;
}

export interface UiAction {
	action: "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: Array<{ x: number; y: number } | [number, number]>;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface ActParams extends StateTargetParams {
	actions: UiAction[];
	expect?: UiCondition;
}

export interface ReadTextParams extends StateTargetParams {
	ref: string;
	offset?: number;
}

export interface WaitForParams extends StateTargetParams, UiCondition {}

/**
 * Name of the extension's dynamic built-in cli command (`_computer_use`).
 * When the backend is invoked through the cli tool, tool results are recorded
 * under toolName "cli" with the backend details nested in
 * details.command.details — session restore unwraps that shape.
 */
export const CLI_COMMAND_NAME = "_computer_use";

export const AGENT_TOOL_NAMES = new Set([
	"find_roots",
	"read_text",
	"wait_for",
	"observe_ui",
	"search_ui",
	"expand_ui",
	"inspect_ui",
	"act_ui",
]);
