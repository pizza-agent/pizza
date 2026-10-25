import type { MainAgentDocument } from "./main-agent-profile";

/** Unsaved source edits survive closing the dock or switching tabs. Memory
 * only: personal notes are never copied into browser persistent storage. */
export const mainAgentDrafts = new Map<string, { document: MainAgentDocument; content: string }>();
export const mainAgentDraftKey = (workspace: string, sourceId: string) => `${workspace}\0${sourceId}`;
