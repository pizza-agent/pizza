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
import { createToolDefinition } from "../tools/index.js";
import type { BashToolOptions } from "../tools/bash.js";
import { createHistoryTreeToolDefinition } from "../tools/history-tree.js";
import { createSessionSplitToolDefinition } from "../tools/session-split.js";
import { createTellToolDefinition } from "../tools/tell.js";

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
	toolOptions: { read: { autoResizeImages: boolean }; cli: BashToolOptions };
}

export type PromptBuilder = (definitions: ExtensionToolDefinition[]) => string;

export function createPromptBuilder(deps: PromptBuilderDeps): PromptBuilder {
	const { cwd, agentDir, mainDir, memoryDir, isMainAgent, resourceLoader, sessionManager, toolOptions } = deps;

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

		// read/write/edit/session_split/history_tree/tell are built-in
		// cli commands routed internally by the cli tool, not separate tools; ensure
		// their prompt guidelines are included whenever the cli tool is active, so the
		// model sees how to use each built-in under the single cli tool.
		if (definitions.some((definition) => definition.name === "cli" || definition.name === "bash")) {
			// Only promptGuidelines is consumed below; type loosely to avoid
			// renderCall contravariance between the concrete tool definitions.
			const builtinDefs: Array<{ promptGuidelines?: string[] }> = [
				createToolDefinition("read", cwd, toolOptions),
				createToolDefinition("write", cwd, toolOptions),
				createToolDefinition("edit", cwd, toolOptions),
				createSessionSplitToolDefinition(),
				createHistoryTreeToolDefinition(),
			];
			if (agentDir) {
				builtinDefs.push(createTellToolDefinition({ agentDir, mainDir }));
			}
			for (const builtinDef of builtinDefs) {
				for (const guideline of builtinDef.promptGuidelines ?? []) {
					const normalized = guideline.trim();
					if (normalized) {
						promptGuidelines.push(normalized);
					}
				}
			}
		}

		// Main-agent identity + long-term memory index + guidelines.
		const soulFile = isMainAgent ? resourceLoader.getSoulFile?.() : undefined;
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
			toolSnippets,
			promptGuidelines,
			soulFile,
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