/**
 * Public SDK entry point.
 *
 * Exposes `createSessionFacade()` as the primary session creation API,
 * plus tool factories and type exports for extension development.
 */

export {
	createSessionFacade,
	type CreateSessionFacadeOptions,
	type CreateSessionFacadeResult,
} from "./session/session-facade-factory.js";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.js";
export type { PromptTemplate } from "./context/prompt-templates.js";
export type { Skill } from "./skills/skills.js";
export type { Tool } from "./tools/index.js";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
} from "./tools/index.js";
