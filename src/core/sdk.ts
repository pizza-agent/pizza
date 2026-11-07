/**
 * Public SDK entry point.
 *
 * Exposes `createSessionFacade()` as the primary session creation API,
 * plus the cli command-table helpers and type exports for extension development.
 */

export {
	createSessionFacade,
	type CreateSessionFacadeOptions,
	type CreateSessionFacadeResult,
} from "./session/session-facade-factory.js";
export type {
	CliCommandDefinition,
	CliCommandParseMeta,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolCallIntent,
	ToolDefinition,
} from "./extensions/index.js";
export { defineCliCommand } from "./extensions/index.js";
export type { PromptTemplate } from "./context/prompt-templates.js";
export type { Skill } from "./skills/skills.js";
export type {
	DefaultResourceLoaderOptions,
	ResourceLoader,
} from "./config/resource-loader.js";
export { DefaultResourceLoader } from "./config/resource-loader.js";
export {
	BUILTIN_COMMANDS,
	type BuiltinCommand,
	DEFAULT_TOOLS,
	type ShellOptions,
	type ShellPolicy,
	type ToolsOptionEntry,
	withFileMutationQueue,
} from "./tools/index.js";

export * from "./event-store/async-storage.js";
export * from "./event-store/async-projection-store.js";
export * from "./event-store/postgres-storage.js";
export * from "./event-store/sqlite-snapshot.js";

// The SDK's own TypeBox instance. Tool `parameters` must be built with it:
// a second TypeBox copy in the host breaks TSchema's unique [Kind] symbol typing.
export { Type, type Static, type TSchema } from "@sinclair/typebox";
