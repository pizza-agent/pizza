/**
 * System prompt construction phase for createSessionFacade.
 *
 * Builds the full system prompt for a set of active tool definitions:
 * tool snippets + guidelines, built-in cli command guidelines, main-agent
 * identity/memory, custom prompt, and the session-position breadcrumb.
 */

import { APP_NAME, getMainSoulPath } from "../../config.js";
import { getMainAgentGuidelines, isSoulUninitialized } from "../agent/main-agent.js";
import type { ToolDefinition as ExtensionToolDefinition } from "../extensions/index.js";
import { buildSessionBreadcrumb } from "../projection/history-tree.js";
import type { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";
import type { ResourceLoader } from "../config/resource-loader.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import type { CommandRegistry } from "../tools/command-registry.js";
import type { ShellOptions } from "../tools/shell.js";

export interface PromptBuilderDeps {
	cwd: string;
	/** SQLite event-store path for this workspace — surfaced in the system
	 * prompt Environment section so the model can find its own history/logs. */
	eventStorePath?: string;
	agentDir: string | undefined;
	mainDir: string;
	memoryDir: string | undefined;
	isMainAgent: boolean;
	mainInitiativePrompt?: () => string;
	resourceLoader: ResourceLoader;
	sessionManager: ProjectionSessionManager;
	/** The cli tool's command table; its available commands are documented in the prompt. */
	commandRegistry: CommandRegistry;
	/** Shell fallback of the cli tool; undefined when disabled. */
	shell: ShellOptions | undefined;
}

export type PromptBuilder = (definitions: ExtensionToolDefinition[]) => string;

export function createPromptBuilder(deps: PromptBuilderDeps): PromptBuilder {
	const { cwd, mainDir, memoryDir, isMainAgent, resourceLoader, sessionManager, commandRegistry, shell } = deps;

	return (definitions: ExtensionToolDefinition[]): string => {
		const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const definition of definitions) {
			const snippet = definition.promptSnippet?.trim();
			if (snippet) {
				toolSnippets[definition.name] = snippet;
			}
			for (const guideline of definition.promptGuidelines ?? []) {
				const normalized = guideline.trim();
				if (normalized) {
					promptGuidelines.push(normalized);
				}
			}
		}

		// Commands of the cli tool are not separate tools: document the ones
		// available right now (built-in, SDK and extension) and collect their
		// guidelines whenever the cli tool is active.
		const hasCli = definitions.some((definition) => definition.name === "cli");
		const cliCommands = hasCli ? commandRegistry.available().map((entry) => entry.spec) : [];
		for (const command of cliCommands) {
			for (const guideline of command.promptGuidelines ?? []) {
				const normalized = guideline.trim();
				if (normalized) {
					promptGuidelines.push(normalized);
				}
			}
		}

		// Main-agent identity + long-term memory index + guidelines.
		const soulFile = isMainAgent ? resourceLoader.getSoulFile?.() : undefined;
		const userProfile = isMainAgent ? resourceLoader.getUserProfile?.() : undefined;
		const longTermMemory = isMainAgent ? resourceLoader.getLongTermMemory?.() : undefined;
		let mainAgentBanner: string | undefined;
		if (isMainAgent && memoryDir) {
			const soulPath = mainDir ? getMainSoulPath(mainDir) : undefined;
			const soulUninitialized = soulFile && soulPath
				? isSoulUninitialized(soulFile.content, APP_NAME)
				: false;
			if (soulUninitialized && soulPath) {
				mainAgentBanner = `Your identity at ${soulPath} is not yet defined. Help with the current task first. Offer a small optional introduction only when appropriate; never require onboarding before answering.`;
			}
			for (const guideline of getMainAgentGuidelines(memoryDir, { soulPath, soulUninitialized })) {
				promptGuidelines.push(guideline);
			}
		}

		let prompt = buildSystemPrompt({
			cwd,
			eventStorePath: deps.eventStorePath,
			skills: resourceLoader.getSkills().skills,
			contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
			customPrompt: resourceLoader.getSystemPrompt(),
			appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt.join("\n\n") : undefined,
			selectedTools: definitions.map((definition) => definition.name),
			cli: hasCli
				? {
						commands: cliCommands.map(({ name, description, usage }) => ({ name, description, usage })),
						shell: shell !== undefined,
						shellAllow: shell?.policy?.allow?.map((rule) => (typeof rule === "string" ? rule : rule.toString())),
					}
				: undefined,
			toolSnippets,
			promptGuidelines,
			soulFile,
			userProfile,
			longTermMemory,
			mainAgentBanner,
		});

		// Append session-position breadcrumb (~15-40 tokens) so the model
		// always knows where it is in the branch tree without calling
		// history_tree list every turn.
		const breadcrumb = buildSessionBreadcrumb(
			sessionManager.listSessions(),
			sessionManager.getActiveSessionId(),
		);
		if (breadcrumb) {
			prompt += `\n${breadcrumb}`;
		}

		if (isMainAgent && deps.mainInitiativePrompt) prompt += deps.mainInitiativePrompt();
		return prompt;
	};
}