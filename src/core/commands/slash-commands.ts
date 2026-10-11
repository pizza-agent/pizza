import type { SourceInfo } from "../skills/source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "export", description: "Export session to HTML" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "stats", description: "Show session statistics" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "rewind", description: "Create a new fork from a previous user message" },
	{ name: "history", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "debug", description: "Show debug information" },
	{ name: "quit", description: "Quit Pizza" },
];
