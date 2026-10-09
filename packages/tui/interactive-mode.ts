/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to SessionFacade.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentMessage,
  ThinkingLevel,
} from "../../src/core/agent/types.js";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
} from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  AutocompleteItem,
  EditorComponent,
  EditorTheme,
  Keybinding,
  KeyId,
  MarkdownTheme,
  OverlayHandle,
  OverlayOptions,
  SlashCommand,
} from "@earendil-works/pi-tui";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  fuzzyFilter,
  Loader,
  type LoaderIndicatorOptions,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  setKeybindings,
  Text,
  TruncatedText,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
  APP_NAME,
  getAgentDir,
  getAuthPath,
  getDebugLogPath,
  getShareViewerUrl,
  VERSION,
} from "../../src/config.js";
import { getBuiltinSkillInfos } from "../../src/builtin-skills/index.js";
import { getApiKeyOptions } from "../../src/core/oauth.js";
import { parseSkillBlock } from "../../src/core/skill-block-parser.js";
import { executeBashWithOperations } from "../../src/core/bash-executor.js";
import {
  createLocalBashOperations,
  type BashOperations,
} from "../../src/core/tools/bash.js";

import type { SessionFacade } from "../../src/core/session-facade.js";
import type { CreateSessionFacadeResult } from "../../src/core/session-facade-factory.js";
import type {
  ApprovalHandler,
  IntentClassification,
} from "../../src/core/intent/types.js";
import type { ModeEvent } from "../../src/modes/event-mapper.js";
import { mapTypedEventToModeEvents } from "../../src/modes/event-mapper.js";
import type { EventBase } from "../../src/core/event-store/types.js";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionRunner,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "../../src/core/extensions/index.js";
import {
  FooterDataProvider,
  type ReadonlyFooterDataProvider,
} from "../../src/core/footer-data-provider.js";
import {
  type AppKeybinding,
  KeybindingsManager,
} from "../../src/core/keybindings.js";
import { computeMessageStats } from "../../src/core/session-stats.js";
import { createCompactionSummaryMessage } from "../../src/core/messages.js";
import {
  defaultModelPerProvider,
  findExactModelReferenceMatch,
} from "../../src/core/model-resolver.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { GoalProjection } from "../../src/core/projection/goal-projection.js";
import {
  buildRecentTaskHistory,
  TASK_HISTORY_EVENT_TYPES,
} from "../../src/core/projection/task-history.js";
import type {
  ResourceDiagnostic,
  ResourceLoader,
} from "../../src/core/resource-loader.js";
import {
  formatMissingSessionCwdPrompt,
  MissingSessionCwdError,
} from "../../src/core/session-cwd.js";
import {
  type SessionEntry,
  type SessionTreeNode,
} from "../../src/core/types/session-types.js";
import {
  listWorkspaceSessions,
  listAllSessions,
} from "../../src/core/session-listing.js";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.js";
import type { SourceInfo } from "../../src/core/source-info.js";
import type { TruncationResult } from "../../src/core/tools/truncate.js";
import { copyToClipboard } from "../../src/utils/clipboard.js";
import {
  extensionForImageMimeType,
  readClipboardImage,
} from "../../src/utils/clipboard-image.js";
import { parseGitUrl } from "../../src/utils/git.js";
import {
  findSourceInfoForPath,
  formatContextPath,
  formatDisplayPath,
  formatPathWithSource,
  getCompactDisplayPathSegments,
  getCompactExtensionLabel,
  getCompactPackageSourceLabel,
  getCompactPathLabel,
  getDisplaySourceInfo,
  getScopeGroup,
  getShortPath,
  isPackageSource,
} from "./resource-path-format.js";
import { killTrackedDetachedChildren } from "../../src/utils/shell.js";
import { ensureTool } from "../../src/utils/tools-manager.js";
import { ApprovalDialogComponent } from "./components/approval-dialog.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { BrandHeaderComponent } from "./components/brand-header.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CountdownTimer } from "./components/countdown-timer.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { keyHint, keyText } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { renderDiff } from "./components/diff.js";
import { truncateToVisualLines } from "./components/visual-truncate.js";
import { installToolRenderBridge } from "../../src/core/tools/render-bridge.js";
import {
  getAvailableThemes,
  getAvailableThemesWithPaths,
  getEditorTheme,
  getLanguageFromPath,
  getMarkdownTheme,
  getThemeByName,
  highlightCode,
  initTheme,
  onThemeChange,
  setRegisteredThemes,
  setTheme,
  setThemeInstance,
  stopThemeWatcher,
  Theme,
  type ThemeColor,
  theme,
} from "./theme/theme.js";

// Give core tool renderers their real TUI implementations. Headless entry
// points never run this module, so they keep the plain fallback bridge.
installToolRenderBridge({
  theme,
  keyHint: (keybinding, description) => keyHint(keybinding as Keybinding, description),
  truncateToVisualLines,
  renderDiff,
  highlightCode,
  getLanguageFromPath,
});

/** Interface for components that can be expanded/collapsed */
interface Expandable {
  setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "setExpanded" in obj &&
    typeof obj.setExpanded === "function"
  );
}

class ExpandableText extends Text implements Expandable {
  constructor(
    private readonly getCollapsedText: () => string,
    private readonly getExpandedText: () => string,
    expanded = false,
    paddingX = 0,
    paddingY = 0,
  ) {
    super(
      expanded ? getExpandedText() : getCollapsedText(),
      paddingX,
      paddingY,
    );
  }

  setExpanded(expanded: boolean): void {
    this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
  }
}

type CompactionQueuedMessage = {
  text: string;
  mode: "steer" | "followUp";
};

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
  "Anthropic subscription auth is active. Third-party usage now draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
  return (
    !!model &&
    model.provider === "unknown" &&
    model.id === "unknown" &&
    model.api === "unknown"
  );
}

function hasDefaultModelProvider(
  providerId: string,
): providerId is keyof typeof defaultModelPerProvider {
  return providerId in defaultModelPerProvider;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
  /** Warning message if session model couldn't be restored */
  modelFallbackMessage?: string;
  /** Initial message to send on startup (can include @file content) */
  initialMessage?: string;
  /** Images to attach to the initial message */
  initialImages?: ImageContent[];
  /** Additional messages to send after the initial message */
  initialMessages?: string[];
  /** Force verbose startup (overrides quietStartup setting) */
  verbose?: boolean;
}

export class InteractiveMode {
  // New path (SessionFacade) — always set via fromFacade()
  private facade!: SessionFacade;
  private facadeResult?: CreateSessionFacadeResult;
  private options: InteractiveModeOptions = {};
  // State tracked from event stream (facade mode)
  private _isStreaming = false;
  private _isCompacting = false;
  private _retryAttempt = 0;
  private _streamingText = "";
  private ui!: TUI;
  private chatContainer!: Container;
  private pendingMessagesContainer!: Container;
  private statusContainer!: Container;
  private defaultEditor!: CustomEditor;
  private editor!: EditorComponent;
  private autocompleteProvider: CombinedAutocompleteProvider | undefined;
  private fdPath: string | undefined;
  private editorContainer!: Container;
  private footer!: FooterComponent;
  private footerDataProvider!: FooterDataProvider;
  private keybindings!: KeybindingsManager;
  private version!: string;
  private isInitialized = false;
  private onInputCallback?: (text: string) => void;
  private loadingAnimation: Loader | undefined = undefined;
  private pendingWorkingMessage: string | undefined = undefined;
  private workingIndicatorOptions: LoaderIndicatorOptions | undefined =
    undefined;
  private readonly defaultWorkingMessage = "Working...";
  private readonly defaultHiddenThinkingLabel = "Thinking...";
  private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;
  private lastSigintTime = 0;
  private lastEscapeTime = 0;
  private anthropicSubscriptionWarningShown = false;
  private lastStatusSpacer: Spacer | undefined = undefined;
  private lastStatusText: Text | undefined = undefined;
  private streamingComponent: AssistantMessageComponent | undefined = undefined;
  private streamingMessage: AssistantMessage | undefined = undefined;
  private pendingTools = new Map<string, ToolExecutionComponent>();
  private isFirstUserMessage = true;
  private toolOutputExpanded = false;
  private hideThinkingBlock = false;
  private skillCommands = new Map<string, string>();
  private unsubscribe?: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isBashMode = false;
  private bashComponent: BashExecutionComponent | undefined = undefined;
  private pendingBashComponents: BashExecutionComponent[] = [];
  private bashAbortController: AbortController | undefined = undefined;
  private autoCompactionLoader: Loader | undefined = undefined;
  private autoCompactionEscapeHandler?: () => void;
  private retryLoader: Loader | undefined = undefined;
  private retryCountdown: CountdownTimer | undefined = undefined;
  private retryEscapeHandler?: () => void;
  private compactionQueuedMessages: CompactionQueuedMessage[] = [];
  private shutdownRequested = false;
  private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
  private extensionInput: ExtensionInputComponent | undefined = undefined;
  private extensionEditor: ExtensionEditorComponent | undefined = undefined;
  private approvalDialogComponent: ApprovalDialogComponent | undefined =
    undefined;
  private pendingApprovalEventId: string | undefined = undefined;
  private approvalOverlayHandle: OverlayHandle | undefined = undefined;
  private extensionTerminalInputUnsubscribers = new Set<() => void>();
  private extensionWidgetsAbove = new Map<
    string,
    Component & { dispose?(): void }
  >();
  private extensionWidgetsBelow = new Map<
    string,
    Component & { dispose?(): void }
  >();
  private widgetContainerAbove!: Container;
  private widgetContainerBelow!: Container;
  private customFooter: (Component & { dispose?(): void }) | undefined =
    undefined;
  private headerContainer!: Container;
  private builtInHeader: BrandHeaderComponent | undefined = undefined;
  private customHeader: (Component & { dispose?(): void }) | undefined =
    undefined;
  private taskHistoryProjection: GoalProjection | undefined = undefined;
  private taskHistoryUnsubscribe: (() => void) | undefined = undefined;

  // ── Property accessors ──────────────────────────────────

  private get modelRegistryValue() {
    return this.facade.modelRegistry!;
  }

  private get extensionRunnerValue(): ExtensionRunner {
    return this.facade.extensionRunner!;
  }

  private get resourceLoaderValue(): ResourceLoader {
    return this.facade.resourceLoader!;
  }

  private get currentModel() {
    return this.getCurrentModelFromFacade();
  }

  private getCurrentModelFromFacade(): Model<any> | undefined {
    const current = this.facade.model;
    const registry = this.facade.modelRegistry;
    const resolved = registry?.find(current.provider, current.model_id);
    if (resolved) return resolved as Model<any>;

    const initialModel = this.facadeResult?.model;
    if (
      initialModel?.provider === current.provider &&
      initialModel.id === current.model_id
    ) {
      return initialModel as Model<any>;
    }

    return undefined;
  }
  private get currentThinkingLevel(): ThinkingLevel {
    return (this.facade.thinkingLevel ?? "off") as ThinkingLevel;
  }

  private get isStreaming() {
    return this._isStreaming;
  }

  private get isCompacting() {
    return this._isCompacting;
  }

  private get autoCompactionEnabled() {
    return this.settingsManager.getCompactionEnabled();
  }

  private get promptTemplatesValue() {
    return this.facade.resourceLoader?.getPrompts().prompts ?? [];
  }

  private get pendingMessageCountValue() {
    return 0;
  }

  private get messagesValue() {
    return this.facade.getProjection().buildContext().messages;
  }

  private get retryAttemptValue() {
    return this._retryAttempt;
  }

  private get systemPromptValue() {
    return this.facade.systemPrompt;
  }

  private get isBashRunningValue() {
    return this.bashAbortController !== undefined;
  }

  private async compactFacade(customInstructions?: string) {
    this.facade.compact();
    await this.facade.waitForIdle();
    return { success: true, tokensBefore: 0, tokensAfter: 0 } as any;
  }

  private getContextUsageFacade() {
    const model = this.getCurrentModelFromFacade();
    const contextWindow = (model as any)?.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;
    const messages = this.facade.getProjection().buildContext().messages;
    const tokens = messages.reduce((sum, msg) => {
      const content = (msg as any).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("")
            : "";
      return sum + Math.ceil(text.length / 4);
    }, 0);
    return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
  }

  // ── Method wrappers ──────────────────────────────────
  private abortCompactionFacade(): void {
    this.facade.abort();
  }
  private abortRetryFacade(): void {
    this.facade.abort();
  }
  private abortBashFacade(): void {
    if (this.bashAbortController) {
      this.bashAbortController.abort();
    }
  }
  private abortBranchSummaryFacade(): void {
    // No-op in facade mode
  }
  private async setModelFacade(model: any): Promise<void> {
    this.facade.setModel(model);
  }
  private setThinkingLevelFacade(level: ThinkingLevel): void {
    this.facade.thinkingLevel = level;
  }
  private setAutoCompactionEnabledFacade(enabled: boolean): void {
    this.settingsManager.setCompactionEnabled(enabled);
  }
  private async cycleModelFacade(
    direction: "forward" | "backward",
  ): Promise<any> {
    const models = this.modelRegistryValue.getAvailable();
    if (models.length <= 1) {
      return { success: false as const, message: "Only one model available" };
    }
    const currentId = this.facade.model.model_id;
    const currentIndex = models.findIndex((m: any) => m.id === currentId);
    const nextIndex =
      direction === "forward"
        ? (currentIndex + 1) % models.length
        : (currentIndex - 1 + models.length) % models.length;
    const nextModel = models[nextIndex];
    this.facade.setModel(nextModel);
    return { success: true as const, model: nextModel };
  }
  private cycleThinkingLevelFacade(): ThinkingLevel | undefined {
    const levels = this.getAvailableThinkingLevelsFacade();
    const current = (this.facade.thinkingLevel ?? "off") as ThinkingLevel;
    const currentIndex = levels.indexOf(current);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels[nextIndex];
    this.facade.thinkingLevel = nextLevel;
    return nextLevel;
  }
  private getAvailableThinkingLevelsFacade(): ThinkingLevel[] {
    // Use pi-ai's per-model capability map so models that declare xhigh/max
    // in their thinkingLevelMap actually expose those levels (previously this
    // was hardcoded to off/low/medium/high, hiding xhigh and max everywhere).
    // Falls back to a sensible default set if the model isn't resolved yet.
    const currentModel = this.getCurrentModelFromFacade();
    if (currentModel) {
      return getSupportedThinkingLevels(currentModel) as ThinkingLevel[];
    }
    return ["off", "low", "medium", "high"];
  }
  private async navigateTreeFacade(
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string } = {},
  ): Promise<{ cancelled?: boolean; aborted?: boolean; editorText?: string }> {
    // Fork at the target event
    await this.waitForTurnIdleBeforeSessionChange();
    this.facade.runtime.fork(targetId);
    return {};
  }
  private getSteeringMessagesFacade(): readonly string[] {
    return this.facade?.getQueuedMessages().steering ?? [];
  }
  private getFollowUpMessagesFacade(): readonly string[] {
    return this.facade?.getQueuedMessages().followUp ?? [];
  }
  private clearQueueFacade(): { steering: string[]; followUp: string[] } {
    return this.facade?.clearQueuedMessages() ?? { steering: [], followUp: [] };
  }
  private getUserMessagesForForkingFacade(): Array<{
    entryId: string;
    text: string;
  }> {
    const messages = this.facade.getProjection().buildContext().messages;
    return messages
      .filter((m) => m.role === "user")
      .map((m) => {
        const entryId =
          "entryId" in m && typeof m.entryId === "string" ? m.entryId : "";
        const content = m.content;
        return { entryId, text: typeof content === "string" ? content : "" };
      });
  }
  private getLastAssistantTextFacade(): string | undefined {
    const messages = this.facade.getProjection().buildContext().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const content = msg.content;
        return typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
            : undefined;
      }
    }
    return undefined;
  }
  private async exportToHtmlFacade(outputPath?: string): Promise<string> {
    const ref = this.sessionFile;
    if (!ref) throw new Error("Cannot export in-memory session");
    const { exportFromFile } =
      await import("../../src/core/export-html/index.js");
    return exportFromFile(ref, outputPath);
  }
  private async reloadFacade(): Promise<void> {
    // No-op in facade mode
  }
  private async executeBashFacade(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: any,
  ): Promise<any> {
    const operations: BashOperations =
      options?.operations ?? createLocalBashOperations();
    this.bashAbortController = new AbortController();
    const startTime = Date.now();
    try {
      const result = await executeBashWithOperations(
        command,
        this.facadeCwd,
        operations,
        {
          onChunk,
          signal: this.bashAbortController.signal,
        },
      );
      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.bashAbortController = undefined;
    }
  }
  private recordBashResultFacade(
    command: string,
    result: any,
    options?: { excludeFromContext?: boolean },
  ): void {
    this.facade.runtime.store.append({
      actor_id: "user",
      type: "BASH_EXECUTION",
      payload: {
        command,
        output: result.output ?? "",
        exit_code: result.exitCode,
        cancelled: result.cancelled ?? false,
        truncated: result.truncated ?? false,
        full_output_path: result.fullOutputPath,
        cwd: this.facadeCwd,
        duration_ms: result.durationMs,
        exclude_from_context: options?.excludeFromContext ?? false,
      },
    });
  }
  private async waitForIdleFacade(): Promise<void> {
    await this.facade.waitForIdle();
  }

  // Convenience accessors
  private get projectionSessionManager() {
    return this.facade.runtime.sessionManager!;
  }
  /** Session directory (workspace dir in agent storage) */
  private get sessionDir(): string {
    const agentDir = this.facade.runtime.agentDir;
    const workspaceId = this.facade
      .getProjection()
      .getDescriptor().workspace_id;
    return path.join(agentDir, "workspaces", workspaceId);
  }
  /** Current session reference string for session selector */
  private get sessionFile(): string | undefined {
    const desc = this.facade.getProjection().getDescriptor();
    return `event-session:${desc.workspace_id}:${desc.session_id}`;
  }
  private get facadeCwd(): string {
    return this.facade?.runtime?.cwd ?? process.cwd();
  }
  private get settingsManager() {
    return this.facade.settingsManager;
  }
  private getExtensionSessionManager() {
    const { EventStoreExtensionSessionManager } =
      require("../../src/core/extensions/session-context.js") as typeof import("../../src/core/extensions/session-context.js");
    return new EventStoreExtensionSessionManager({
      store: this.facade.runtime.store,
      projection: this.facade.getProjection(),
      cwd: this.facadeCwd,
      sessionDir: this.sessionDir,
      sessionFile: this.sessionFile,
    });
  }

  /**
   * Create InteractiveMode with SessionFacade (event-sourced architecture).
   */
  static fromFacade(
    facadeResult: CreateSessionFacadeResult,
    options: InteractiveModeOptions = {},
  ): InteractiveMode {
    const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
    mode.facade = facadeResult.facade;
    mode.facadeResult = facadeResult;
    mode.options = options;
    mode._isStreaming = false;
    mode._isCompacting = false;
    mode._retryAttempt = 0;
    mode._streamingText = "";
    mode.signalCleanupHandlers = [];
    mode.initUI();
    mode.facade.runtime.setApprovalHandler(mode.createApprovalHandler());
    return mode;
  }

  private createApprovalHandler(): ApprovalHandler {
    return {
      requestApproval: (intentEventId, classification, toolName, args) => {
        this.showApprovalDialog(
          intentEventId,
          classification,
          toolName ?? "unknown",
          args ?? {},
        );
      },
      cancelApproval: (intentEventId) => {
        if (this.approvalDialogComponent) {
          this.hideApprovalDialog();
        }
      },
    };
  }

  /** Shared UI initialization */
  private initUI(): void {
    const settingsMgr = this.settingsManager;
    this.version = VERSION;
    this.ui = new TuiMainScreen(
      new ProcessTerminal(),
      settingsMgr.getShowHardwareCursor(),
    );
    this.ui.setClearOnShrink(settingsMgr.getClearOnShrink());
    this.headerContainer = new Container();
    this.chatContainer = new Container();
    this.pendingMessagesContainer = new Container();
    this.statusContainer = new Container();
    this.widgetContainerAbove = new Container();
    // Initialize collections that are skipped by Object.create in fromFacade()
    this.widgetContainerBelow = new Container();
    this.pendingTools ??= new Map();
    this.skillCommands ??= new Map();
    this.extensionTerminalInputUnsubscribers ??= new Set();
    this.extensionWidgetsAbove ??= new Map();
    this.extensionWidgetsBelow ??= new Map();
    this.pendingBashComponents ??= [];
    this.signalCleanupHandlers ??= [];
    this.compactionQueuedMessages ??= [];
    this.keybindings = KeybindingsManager.create();
    setKeybindings(this.keybindings);
    const editorPaddingX = settingsMgr.getEditorPaddingX();
    const autocompleteMaxVisible = settingsMgr.getAutocompleteMaxVisible();
    this.defaultEditor = new CustomEditor(
      this.ui,
      getEditorTheme(),
      this.keybindings,
      {
        paddingX: editorPaddingX,
        autocompleteMaxVisible,
      },
    );
    this.editor = this.defaultEditor;
    this.editorContainer = new Container();
    this.editorContainer.addChild(this.editor as Component);
    const cwd = this.facade.runtime.cwd ?? process.cwd();
    this.footerDataProvider = new FooterDataProvider(cwd);
    this.footer = new FooterComponent(
      this.createFacadeFooterInfo(),
      this.footerDataProvider,
    );
    this.hideThinkingBlock = settingsMgr.getHideThinkingBlock();
    const resourceLoader = this.facade.resourceLoader!;
    setRegisteredThemes(resourceLoader.getThemes().themes);
    initTheme(settingsMgr.getTheme(), true);
  }

  private createFacadeFooterInfo() {
    const facade = this.facade!;
    return {
      getModel: () => {
        const facadeModel = this.getCurrentModelFromFacade();
        if (!facadeModel) return undefined;
        return {
          id: facadeModel.id,
          provider: facadeModel.provider,
          reasoning: facadeModel.reasoning,
          contextWindow: facadeModel.contextWindow,
        };
      },
      getThinkingLevel: () => facade.thinkingLevel,
      getTokenUsage: () => {
        const messages = facade.getProjection().buildContext().messages;
        let totalInput = 0,
          totalOutput = 0,
          totalCacheRead = 0,
          totalCacheWrite = 0,
          totalCost = 0;
        for (const msg of messages) {
          if (msg.role === "assistant" && (msg as any).usage) {
            const u = (msg as any).usage;
            totalInput += u.input ?? 0;
            totalOutput += u.output ?? 0;
            totalCacheRead += u.cacheRead ?? 0;
            totalCacheWrite += u.cacheWrite ?? 0;
            totalCost += u.cost?.total ?? 0;
          }
        }
        return {
          totalInput,
          totalOutput,
          totalCacheRead,
          totalCacheWrite,
          totalCost,
        };
      },
      getContextUsage: () => {
        const facadeModel = this.getCurrentModelFromFacade();
        const contextWindow = facadeModel?.contextWindow ?? 0;
        if (contextWindow <= 0) return undefined;
        const messages = facade.getProjection().buildContext().messages;
        const tokens = messages.reduce((sum, msg) => {
          const content = "content" in msg ? msg.content : undefined;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("")
                : "";
          return sum + Math.ceil(text.length / 4);
        }, 0);
        return {
          tokens,
          contextWindow,
          percent: (tokens / contextWindow) * 100,
        };
      },
      getCwd: () => facade.runtime.cwd,
      isUsingOAuthSubscription: () => {
        const facadeModel = this.getCurrentModelFromFacade();
        return facadeModel
          ? (facade.modelRegistry?.isUsingOAuth?.(facadeModel as any) ?? false)
          : false;
      },
    };
  }

  private getAutocompleteSourceTag(
    sourceInfo?: SourceInfo,
  ): string | undefined {
    if (!sourceInfo) {
      return undefined;
    }

    const scopePrefix =
      sourceInfo.scope === "user"
        ? "u"
        : sourceInfo.scope === "project"
          ? "p"
          : "t";
    const source = sourceInfo.source.trim();

    if (source === "auto" || source === "local" || source === "cli") {
      return scopePrefix;
    }

    if (source.startsWith("npm:")) {
      return `${scopePrefix}:${source}`;
    }

    const gitSource = parseGitUrl(source);
    if (gitSource) {
      const ref = gitSource.ref ? `@${gitSource.ref}` : "";
      return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
    }

    return scopePrefix;
  }

  private prefixAutocompleteDescription(
    description: string | undefined,
    sourceInfo?: SourceInfo,
  ): string | undefined {
    const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
    if (!sourceTag) {
      return description;
    }
    return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
  }

  private getBuiltInCommandConflictDiagnostics(
    extensionRunner: ExtensionRunner,
  ): ResourceDiagnostic[] {
    const builtinNames = new Set(
      BUILTIN_SLASH_COMMANDS.map((command) => command.name),
    );
    return extensionRunner
      .getRegisteredCommands()
      .filter((command) => builtinNames.has(command.name))
      .map((command) => ({
        type: "warning" as const,
        message:
          command.invocationName === command.name
            ? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
            : `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
        path: command.sourceInfo.path,
      }));
  }

  private setupAutocomplete(fdPath: string | undefined): void {
    // Define commands for autocomplete
    const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map(
      (command) => ({
        name: command.name,
        description: command.description,
      }),
    );

    const modelCommand = slashCommands.find(
      (command) => command.name === "model",
    );
    if (modelCommand) {
      modelCommand.getArgumentCompletions = (
        prefix: string,
      ): AutocompleteItem[] | null => {
        const models = this.modelRegistryValue.getAvailable();

        if (models.length === 0) return null;

        // Create items with provider/id format
        const items = models.map((m: any) => ({
          id: m.id,
          provider: m.provider,
          label: `${m.provider}/${m.id}`,
        }));

        // Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
        const filtered = fuzzyFilter(
          items,
          prefix,
          (item) => `${item.id} ${item.provider}`,
        );

        if (filtered.length === 0) return null;

        return filtered.map((item) => ({
          value: item.label,
          label: item.id,
          description: item.provider,
        }));
      };
    }

    // Convert prompt templates to SlashCommand format for autocomplete
    const templateCommands: SlashCommand[] = this.promptTemplatesValue.map(
      (cmd: any) => ({
        name: cmd.name,
        description: this.prefixAutocompleteDescription(
          cmd.description,
          cmd.sourceInfo,
        ),
        ...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
      }),
    );

    // Convert extension commands to SlashCommand format
    const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
    const extensionCommands: SlashCommand[] = this.extensionRunnerValue
      .getRegisteredCommands()
      .filter((cmd) => !builtinCommandNames.has(cmd.name))
      .map((cmd) => ({
        name: cmd.invocationName,
        description: this.prefixAutocompleteDescription(
          cmd.description,
          cmd.sourceInfo,
        ),
        getArgumentCompletions: cmd.getArgumentCompletions,
      }));

    // Build skill commands from session.skills (if enabled)
    this.skillCommands.clear();
    const skillCommandList: SlashCommand[] = [];
    if (this.settingsManager.getEnableSkillCommands()) {
      for (const skill of this.resourceLoaderValue.getSkills().skills) {
        const commandName = `skill:${skill.name}`;
        this.skillCommands.set(commandName, skill.filePath);
        skillCommandList.push({
          name: commandName,
          description: this.prefixAutocompleteDescription(
            skill.description,
            skill.sourceInfo,
          ),
        });
      }
    }

    // Setup autocomplete
    this.autocompleteProvider = new CombinedAutocompleteProvider(
      [
        ...slashCommands,
        ...templateCommands,
        ...extensionCommands,
        ...skillCommandList,
      ],
      this.facadeCwd,
      fdPath,
    );
    this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
    if (this.editor !== this.defaultEditor) {
      this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
    }
  }

  private showStartupNoticesIfNeeded(): void {
    // Changelog display disabled
  }

  private initializeTaskHistoryHeader(): void {
    this.taskHistoryUnsubscribe?.();
    this.taskHistoryProjection?.stopLive();

    const projection = new GoalProjection(this.facade.runtime.store);
    projection.rebuild();
    projection.startLive();
    this.taskHistoryProjection = projection;
    this.updateTaskHistoryHeader();

    this.taskHistoryUnsubscribe = this.facade.subscribe(
      () => {
        this.updateTaskHistoryHeader();
        this.ui.requestRender();
      },
      { types: TASK_HISTORY_EVENT_TYPES },
    );
  }

  private updateTaskHistoryHeader(): void {
    if (!this.builtInHeader || !this.taskHistoryProjection) return;
    this.builtInHeader.setTaskHistory(
      buildRecentTaskHistory(this.taskHistoryProjection, 3),
    );
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;

    this.registerSignalHandlers();

    // fd is optional for file autocomplete. Shell find/grep/ls shims
    // handle their own fallback paths when native commands are unavailable.
    const fdPath = await ensureTool("fd", true);
    this.fdPath = fdPath;

    // Add header container as first child
    this.ui.addChild(this.headerContainer);

    // Add branded startup header with compact and expanded shortcut states.
    this.builtInHeader = new BrandHeaderComponent(
      APP_NAME,
      this.version,
      this.getStartupExpansionState(),
    );
    this.initializeTaskHistoryHeader();

    // Setup UI layout
    this.headerContainer.addChild(new Spacer(1));
    this.headerContainer.addChild(this.builtInHeader);
    this.headerContainer.addChild(new Spacer(1));

    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.pendingMessagesContainer);
    this.ui.addChild(this.statusContainer);
    this.renderWidgets(); // Initialize with default spacer
    this.ui.addChild(this.widgetContainerAbove);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.widgetContainerBelow);
    this.ui.addChild(this.footer);
    this.ui.setFocus(this.editor);

    this.setupKeyHandlers();
    this.setupEditorSubmitHandler();

    // Start the UI before initializing extensions so session_start handlers can use interactive dialogs
    this.ui.start();
    this.isInitialized = true;

    // Initialize extensions first so resources are shown before messages
    await this.rebindCurrentSession();

    // Render initial messages AFTER showing loaded resources
    this.renderInitialMessages();

    // Set up theme file watcher
    onThemeChange(() => {
      this.ui.invalidate();
      this.updateEditorBorderColor();
      this.ui.requestRender();
    });

    // Set up git branch watcher (uses provider instead of footer)
    this.footerDataProvider.onBranchChange(() => {
      this.ui.requestRender();
    });

    // Initialize available provider count for footer display
    await this.updateAvailableProviderCount();
  }

  /**
   * Update terminal title with session name and cwd.
   */
  private updateTerminalTitle(): void {
    const cwdBasename = path.basename(this.facadeCwd);
    const appName = theme.web?.title ?? "Pizza";
    this.ui.terminal.setTitle(`${appName} - ${cwdBasename}`);
  }

  /**
   * Run the interactive mode. This is the main entry point.
   * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
   */
  async run(): Promise<void> {
    await this.init();

    // Check tmux keyboard setup asynchronously
    this.checkTmuxKeyboardSetup().then((warning) => {
      if (warning) {
        this.showWarning(warning);
      }
    });

    // Show startup warnings
    const {
      modelFallbackMessage,
      initialMessage,
      initialImages,
      initialMessages,
    } = this.options;

    const modelsJsonError = this.facade
      ? this.facade.modelRegistry?.getError()
      : this.modelRegistryValue.getError();
    if (modelsJsonError) {
      this.showError(`models.json error: ${modelsJsonError}`);
    }

    if (modelFallbackMessage) {
      this.showWarning(modelFallbackMessage);
    }

    void this.maybeWarnAboutAnthropicSubscriptionAuth();

    // Process initial messages
    if (initialMessage) {
      try {
        await this.promptFacadeOrSession(initialMessage, initialImages);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }

    if (initialMessages) {
      for (const message of initialMessages) {
        try {
          await this.promptFacadeOrSession(message);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          this.showError(errorMessage);
        }
      }
    }

    // Main interactive loop
    while (true) {
      const userInput = await this.getUserInput();
      try {
        await this.promptFacadeOrSession(userInput);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }
  }

  private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
    if (!process.env.TMUX) return undefined;

    const runTmuxShow = (option: string): Promise<string | undefined> => {
      return new Promise((resolve) => {
        const proc = spawn("tmux", ["show", "-gv", option], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        let stdout = "";
        const timer = setTimeout(() => {
          proc.kill();
          resolve(undefined);
        }, 2000);

        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.on("error", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : undefined);
        });
      });
    };

    const [extendedKeys, extendedKeysFormat] = await Promise.all([
      runTmuxShow("extended-keys"),
      runTmuxShow("extended-keys-format"),
    ]);

    // If we couldn't query tmux (timeout, sandbox, etc.), don't warn
    if (extendedKeys === undefined) return undefined;

    if (extendedKeys !== "on" && extendedKeys !== "always") {
      return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
    }

    if (extendedKeysFormat === "xterm") {
      return "tmux extended-keys-format is xterm. Pizza works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
    }

    return undefined;
  }
  private getMarkdownThemeWithSettings(): MarkdownTheme {
    return {
      ...getMarkdownTheme(),
      codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
    };
  }

  // =========================================================================
  // Extension System
  // =========================================================================

  private formatDisplayPath(p: string): string {
    return formatDisplayPath(p);
  }

  private formatContextPath(p: string): string {
    return formatContextPath(p, this.facadeCwd);
  }

  private getStartupExpansionState(): boolean {
    return this.options.verbose || this.toolOutputExpanded;
  }

  /**
   * Get a short path relative to the package root for display.
   */
  private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
    return getShortPath(fullPath, sourceInfo);
  }

  private getCompactPathLabel(
    resourcePath: string,
    sourceInfo?: SourceInfo,
  ): string {
    return getCompactPathLabel(resourcePath, sourceInfo);
  }

  private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
    return getCompactPackageSourceLabel(sourceInfo);
  }

  private getCompactExtensionLabel(
    resourcePath: string,
    sourceInfo?: SourceInfo,
  ): string {
    return getCompactExtensionLabel(resourcePath, sourceInfo);
  }

  private getCompactDisplayPathSegments(resourcePath: string): string[] {
    return getCompactDisplayPathSegments(resourcePath);
  }

  private getCompactNonPackageExtensionLabel(
    resourcePath: string,
    index: number,
    allPaths: Array<{ path: string; segments: string[] }>,
  ): string {
    const segments = allPaths[index]?.segments;
    if (!segments || segments.length === 0) {
      return this.getCompactPathLabel(resourcePath);
    }

    for (
      let segmentCount = 1;
      segmentCount <= segments.length;
      segmentCount += 1
    ) {
      const candidate = segments.slice(-segmentCount).join("/");
      const isUnique = allPaths.every((item, itemIndex) => {
        if (itemIndex === index) {
          return true;
        }
        return item.segments.slice(-segmentCount).join("/") !== candidate;
      });

      if (isUnique) {
        return candidate;
      }
    }

    return segments.join("/");
  }

  private getCompactExtensionLabels(
    extensions: Array<{ path: string; sourceInfo?: SourceInfo }>,
  ): string[] {
    const nonPackageExtensions = extensions
      .map((extension) => ({
        path: extension.path,
        sourceInfo: extension.sourceInfo,
        segments: this.getCompactDisplayPathSegments(extension.path),
      }))
      .filter((extension) => !this.isPackageSource(extension.sourceInfo));

    return extensions.map((extension) => {
      if (this.isPackageSource(extension.sourceInfo)) {
        return this.getCompactExtensionLabel(
          extension.path,
          extension.sourceInfo,
        );
      }

      const nonPackageIndex = nonPackageExtensions.findIndex(
        (item) => item.path === extension.path,
      );
      if (nonPackageIndex === -1) {
        return this.getCompactPathLabel(extension.path, extension.sourceInfo);
      }

      return this.getCompactNonPackageExtensionLabel(
        extension.path,
        nonPackageIndex,
        nonPackageExtensions,
      );
    });
  }

  private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
    label: string;
    scopeLabel?: string;
    color: "accent" | "muted";
  } {
    return getDisplaySourceInfo(sourceInfo);
  }

  private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
    return getScopeGroup(sourceInfo);
  }

  private isPackageSource(sourceInfo?: SourceInfo): boolean {
    return isPackageSource(sourceInfo);
  }

  private buildScopeGroups(
    items: Array<{ path: string; sourceInfo?: SourceInfo }>,
  ): Array<{
    scope: "user" | "project" | "path";
    paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
    packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
  }> {
    const groups: Record<
      "user" | "project" | "path",
      {
        scope: "user" | "project" | "path";
        paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
        packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
      }
    > = {
      user: { scope: "user", paths: [], packages: new Map() },
      project: { scope: "project", paths: [], packages: new Map() },
      path: { scope: "path", paths: [], packages: new Map() },
    };

    for (const item of items) {
      const groupKey = this.getScopeGroup(item.sourceInfo);
      const group = groups[groupKey];
      const source = item.sourceInfo?.source ?? "local";

      if (this.isPackageSource(item.sourceInfo)) {
        const list = group.packages.get(source) ?? [];
        list.push(item);
        group.packages.set(source, list);
      } else {
        group.paths.push(item);
      }
    }

    return [groups.project, groups.user, groups.path].filter(
      (group) => group.paths.length > 0 || group.packages.size > 0,
    );
  }

  private formatScopeGroups(
    groups: Array<{
      scope: "user" | "project" | "path";
      paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
      packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
    }>,
    options: {
      formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
      formatPackagePath: (
        item: { path: string; sourceInfo?: SourceInfo },
        source: string,
      ) => string;
    },
  ): string {
    const lines: string[] = [];

    for (const group of groups) {
      lines.push(`  ${theme.fg("accent", group.scope)}`);

      const sortedPaths = [...group.paths].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      for (const item of sortedPaths) {
        lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
      }

      const sortedPackages = Array.from(group.packages.entries()).sort(
        ([a], [b]) => a.localeCompare(b),
      );
      for (const [source, items] of sortedPackages) {
        lines.push(`    ${theme.fg("mdLink", source)}`);
        const sortedPackagePaths = [...items].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        for (const item of sortedPackagePaths) {
          lines.push(
            theme.fg("dim", `      ${options.formatPackagePath(item, source)}`),
          );
        }
      }
    }

    return lines.join("\n");
  }

  private findSourceInfoForPath(
    p: string,
    sourceInfos: Map<string, SourceInfo>,
  ): SourceInfo | undefined {
    return findSourceInfoForPath(p, sourceInfos);
  }

  private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
    return formatPathWithSource(p, sourceInfo);
  }

  private formatDiagnostics(
    diagnostics: readonly ResourceDiagnostic[],
    sourceInfos: Map<string, SourceInfo>,
  ): string {
    const lines: string[] = [];

    // Group collision diagnostics by name
    const collisions = new Map<string, ResourceDiagnostic[]>();
    const otherDiagnostics: ResourceDiagnostic[] = [];

    for (const d of diagnostics) {
      if (d.type === "collision" && d.collision) {
        const list = collisions.get(d.collision.name) ?? [];
        list.push(d);
        collisions.set(d.collision.name, list);
      } else {
        otherDiagnostics.push(d);
      }
    }

    // Format collision diagnostics grouped by name
    for (const [name, collisionList] of collisions) {
      const first = collisionList[0]?.collision;
      if (!first) continue;
      lines.push(theme.fg("warning", `  "${name}" collision:`));
      lines.push(
        theme.fg(
          "dim",
          `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
        ),
      );
      for (const d of collisionList) {
        if (d.collision) {
          lines.push(
            theme.fg(
              "dim",
              `    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
            ),
          );
        }
      }
    }

    for (const d of otherDiagnostics) {
      if (d.path) {
        const formattedPath = this.formatPathWithSource(
          d.path,
          this.findSourceInfoForPath(d.path, sourceInfos),
        );
        lines.push(
          theme.fg(
            d.type === "error" ? "error" : "warning",
            `  ${formattedPath}`,
          ),
        );
        lines.push(
          theme.fg(
            d.type === "error" ? "error" : "warning",
            `    ${d.message}`,
          ),
        );
      } else {
        lines.push(
          theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`),
        );
      }
    }

    return lines.join("\n");
  }

  private showLoadedResources(options?: {
    extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
    force?: boolean;
    showDiagnosticsWhenQuiet?: boolean;
  }): void {
    const showListing =
      options?.force ||
      this.options.verbose ||
      !this.settingsManager.getQuietStartup();
    const showDiagnostics =
      showListing || options?.showDiagnosticsWhenQuiet === true;
    if (!showListing && !showDiagnostics) {
      return;
    }

    const sectionHeader = (name: string, color: ThemeColor = "mdHeading") =>
      theme.fg(color, `[${name}]`);
    const formatCompactList = (
      items: string[],
      options?: { sort?: boolean },
    ): string => {
      const labels = items
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (options?.sort !== false) {
        labels.sort((a, b) => a.localeCompare(b));
      }
      return theme.fg("dim", `  ${labels.join(", ")}`);
    };
    const addLoadedSection = (
      name: string,
      collapsedBody: string,
      expandedBody = collapsedBody,
      color: ThemeColor = "mdHeading",
    ): void => {
      const section = new ExpandableText(
        () => `${sectionHeader(name, color)}\n${collapsedBody}`,
        () => `${sectionHeader(name, color)}\n${expandedBody}`,
        this.getStartupExpansionState(),
        0,
        0,
      );
      this.chatContainer.addChild(section);
      this.chatContainer.addChild(new Spacer(1));
    };

    const skillsResult = this.resourceLoaderValue.getSkills();
    const promptsResult = this.resourceLoaderValue.getPrompts();
    const themesResult = this.resourceLoaderValue.getThemes();
    const extensions =
      options?.extensions ??
      this.resourceLoaderValue.getExtensions().extensions.map((extension) => ({
        path: extension.path,
        sourceInfo: extension.sourceInfo,
      }));
    const sourceInfos = new Map<string, SourceInfo>();
    for (const extension of extensions) {
      if (extension.sourceInfo) {
        sourceInfos.set(extension.path, extension.sourceInfo);
      }
    }
    for (const skill of skillsResult.skills) {
      if (skill.sourceInfo) {
        sourceInfos.set(skill.filePath, skill.sourceInfo);
      }
    }
    for (const prompt of promptsResult.prompts) {
      if (prompt.sourceInfo) {
        sourceInfos.set(prompt.filePath, prompt.sourceInfo);
      }
    }
    for (const loadedTheme of themesResult.themes) {
      if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
        sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
      }
    }

    if (showListing) {
      const contextFiles =
        this.resourceLoaderValue.getAgentsFiles().agentsFiles;
      if (contextFiles.length > 0) {
        this.chatContainer.addChild(new Spacer(1));
        const contextList = contextFiles
          .map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
          .join("\n");
        const contextCompactList = formatCompactList(
          contextFiles.map((contextFile) =>
            this.formatContextPath(contextFile.path),
          ),
          { sort: false },
        );
        addLoadedSection("Context", contextCompactList, contextList);
      }

      const templates = this.promptTemplatesValue;
      if (templates.length > 0) {
        const groups = this.buildScopeGroups(
          templates.map((template) => ({
            path: template.filePath,
            sourceInfo: template.sourceInfo,
          })),
        );
        const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
        const templateList = this.formatScopeGroups(groups, {
          formatPath: (item) => {
            const template = templateByPath.get(item.path);
            return template
              ? `/${template.name}`
              : this.formatDisplayPath(item.path);
          },
          formatPackagePath: (item) => {
            const template = templateByPath.get(item.path);
            return template
              ? `/${template.name}`
              : this.formatDisplayPath(item.path);
          },
        });
        const promptCompactList = formatCompactList(
          templates.map((template) => `/${template.name}`),
        );
        addLoadedSection("Prompts", promptCompactList, templateList);
      }

      if (extensions.length > 0) {
        const groups = this.buildScopeGroups(extensions);
        const extList = this.formatScopeGroups(groups, {
          formatPath: (item) => this.formatDisplayPath(item.path),
          formatPackagePath: (item) =>
            this.getShortPath(item.path, item.sourceInfo),
        });
        const extensionCompactList = formatCompactList(
          this.getCompactExtensionLabels(extensions),
        );
        addLoadedSection(
          "Extensions",
          extensionCompactList,
          extList,
          "mdHeading",
        );
      }

      // Show loaded themes (excluding built-in)
      const loadedThemes = themesResult.themes;
      const customThemes = loadedThemes.filter((t) => t.sourcePath);
      if (customThemes.length > 0) {
        const groups = this.buildScopeGroups(
          customThemes.map((loadedTheme) => ({
            path: loadedTheme.sourcePath!,
            sourceInfo: loadedTheme.sourceInfo,
          })),
        );
        const themeList = this.formatScopeGroups(groups, {
          formatPath: (item) => this.formatDisplayPath(item.path),
          formatPackagePath: (item) =>
            this.getShortPath(item.path, item.sourceInfo),
        });
        const themeCompactList = formatCompactList(
          customThemes.map(
            (loadedTheme) =>
              loadedTheme.name ??
              this.getCompactPathLabel(
                loadedTheme.sourcePath!,
                loadedTheme.sourceInfo,
              ),
          ),
        );
        addLoadedSection("Themes", themeCompactList, themeList);
      }
    }

    if (showDiagnostics) {
      const skillDiagnostics = skillsResult.diagnostics;
      if (skillDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          skillDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const promptDiagnostics = promptsResult.diagnostics;
      if (promptDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          promptDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const extensionDiagnostics: ResourceDiagnostic[] = [];
      const extensionErrors = this.resourceLoaderValue.getExtensions().errors;
      if (extensionErrors.length > 0) {
        for (const error of extensionErrors) {
          extensionDiagnostics.push({
            type: "error",
            message: error.error,
            path: error.path,
          });
        }
      }

      const commandDiagnostics =
        this.extensionRunnerValue.getCommandDiagnostics();
      extensionDiagnostics.push(...commandDiagnostics);
      extensionDiagnostics.push(
        ...this.getBuiltInCommandConflictDiagnostics(this.extensionRunnerValue),
      );

      const shortcutDiagnostics =
        this.extensionRunnerValue.getShortcutDiagnostics();
      extensionDiagnostics.push(...shortcutDiagnostics);

      if (extensionDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          extensionDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Extension issues]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }

      const themeDiagnostics = themesResult.diagnostics;
      if (themeDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(
          themeDiagnostics,
          sourceInfos,
        );
        this.chatContainer.addChild(
          new Text(
            `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`,
            0,
            0,
          ),
        );
        this.chatContainer.addChild(new Spacer(1));
      }
    }
  }

  /**
   * Initialize the extension system with TUI-based UI context.
   */
  private async bindCurrentSessionExtensions(): Promise<void> {
    const uiContext = this.createExtensionUIContext();

    const runner = this.facade.extensionRunner;
    if (runner) {
      runner.setUIContext(uiContext);
      runner.bindCommandContext({
        waitForIdle: () => this.facade!.waitForIdle(),
        newSession: async (options: any) => {
          if (this.loadingAnimation) {
            this.loadingAnimation.stop();
            this.loadingAnimation = undefined;
          }
          this.statusContainer.clear();
          try {
            const result = await this.facade!.runtime.createSession(
              options?.name,
            );
            if (result && !("cancelled" in result && result.cancelled)) {
              this.renderCurrentSessionState();
              this.ui.requestRender();
            }
            return result as any;
          } catch (error: unknown) {
            return this.handleFatalRuntimeError(
              "Failed to create session",
              error,
            );
          }
        },
        fork: async (entryId: string, options: any) => {
          try {
            await this.waitForTurnIdleBeforeSessionChange();
            const result = (await this.facade!.runtime.fork(entryId)) as any;
            if (result && !result.cancelled) {
              this.renderCurrentSessionState();
              this.editor.setText(result.selectedText ?? "");
              this.showStatus("Forked to new session");
            }
            return { cancelled: result?.cancelled ?? false };
          } catch (error: unknown) {
            return this.handleFatalRuntimeError(
              "Failed to fork session",
              error,
            );
          }
        },
        navigateTree: async (targetId: string, _options: any) => {
          await this.waitForTurnIdleBeforeSessionChange();
          this.facade!.runtime.fork(targetId);
          this.chatContainer.clear();
          this.renderInitialMessages();
          this.showStatus("Navigated to selected point");
          void this.flushCompactionQueue({ willRetry: false });
          return { cancelled: false };
        },
        switchSession: async (sessionPath: string, options: any) => {
          return this.handleResumeSession(sessionPath, options);
        },
        reload: async () => {
          await this.handleReloadCommand();
        },
      });
      runner.onError?.((error: any) => {
        this.showExtensionError(error.extensionPath, error.error, error.stack);
      });
      // Emit session start event
      await runner.emit({ type: "session_start", reason: "new" } as any);
      // Discover extension resources
      if (runner.hasHandlers("resources_discover")) {
        const cwd = this.facadeCwd;
        const { skillPaths, promptPaths, themePaths } =
          await runner.emitResourcesDiscover(cwd, "startup");
        if (
          skillPaths.length > 0 ||
          promptPaths.length > 0 ||
          themePaths.length > 0
        ) {
          const resourceLoader = this.facade.resourceLoader;
          if (resourceLoader && "extendResources" in resourceLoader) {
            (resourceLoader as any).extendResources({
              skillPaths,
              promptPaths,
              themePaths,
            });
          }
        }
      }
    }

    setRegisteredThemes(this.resourceLoaderValue.getThemes().themes);
    this.setupAutocomplete(this.fdPath);

    const extensionRunner = this.extensionRunnerValue;
    this.setupExtensionShortcuts(extensionRunner);
    this.showLoadedResources({ force: false });
    this.showStartupNoticesIfNeeded();
  }

  private applyRuntimeSettings(): void {
    this.footer.setSession(this.createFacadeFooterInfo());
    this.footer.setAutoCompactEnabled(this.autoCompactionEnabled);
    this.footerDataProvider.setCwd(this.facadeCwd);
    this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
    this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
    this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
    const editorPaddingX = this.settingsManager.getEditorPaddingX();
    const autocompleteMaxVisible =
      this.settingsManager.getAutocompleteMaxVisible();
    this.defaultEditor.setPaddingX(editorPaddingX);
    this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
    if (this.editor !== this.defaultEditor) {
      this.editor.setPaddingX?.(editorPaddingX);
      this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
    }
  }

  private async rebindCurrentSession(): Promise<void> {
    this.resetExtensionUI();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.applyRuntimeSettings();
    await this.bindCurrentSessionExtensions();
    this.subscribeToAgent();
    await this.updateAvailableProviderCount();
    this.updateEditorBorderColor();
    this.updateTerminalTitle();
  }

  private async handleFatalRuntimeError(
    prefix: string,
    error: unknown,
  ): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    this.showError(`${prefix}: ${message}`);
    stopThemeWatcher();
    this.stop();
    process.exit(1);
  }

  private renderCurrentSessionState(): void {
    this.chatContainer.clear();
    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = undefined;
    this.streamingMessage = undefined;
    this.pendingTools.clear();
    this.renderInitialMessages();
  }

  /**
   * Get a registered tool definition by name (for custom rendering).
   */
  private getRegisteredToolDefinition(toolName: string) {
    return (this.facade.tools as any[]).find((t) => t.name === toolName) as any;
  }

  /**
   * Set up keyboard shortcuts registered by extensions.
   */
  private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
    const shortcuts = extensionRunner.getShortcuts(
      this.keybindings.getEffectiveConfig(),
    );
    if (shortcuts.size === 0) return;

    // Create a context for shortcut handlers
    const createContext = (): ExtensionContext => {
      const base: ExtensionContext = {
        ui: this.createExtensionUIContext(),
        hasUI: true,
        cwd: this.facadeCwd,
        sessionManager: this.getExtensionSessionManager(),
        modelRegistry: this.modelRegistryValue as any,
        model: this.currentModel as any,
        isIdle: () => !this.isStreaming,
        signal: this.facade.signal,
        abort: () => this.facade.abort(),
        hasPendingMessages: () => this.pendingMessageCountValue > 0,
        shutdown: () => {
          this.shutdownRequested = true;
        },
        getContextUsage: () => this.getContextUsageFacade(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compactFacade(
                options?.customInstructions,
              );
              options?.onComplete?.(result);
            } catch (error) {
              const err =
                error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPromptValue,
      };
      return base;
    };

    // Set up the extension shortcut handler on the default editor
    this.defaultEditor.onExtensionShortcut = (data: string) => {
      for (const [shortcutStr, shortcut] of shortcuts) {
        // Cast to KeyId - extension shortcuts use the same format
        if (matchesKey(data, shortcutStr as KeyId)) {
          // Run handler async, don't block input
          Promise.resolve(shortcut.handler(createContext())).catch((err) => {
            this.showError(
              `Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          return true;
        }
      }
      return false;
    };
  }

  /**
   * Set extension status text in the footer.
   */
  private setExtensionStatus(key: string, text: string | undefined): void {
    this.footerDataProvider.setExtensionStatus(key, text);
    this.ui.requestRender();
  }

  private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
    this.workingIndicatorOptions = options;
    this.loadingAnimation?.setIndicator(options);
    this.ui.requestRender();
  }

  private setHiddenThinkingLabel(label?: string): void {
    this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
    for (const child of this.chatContainer.children) {
      if (child instanceof AssistantMessageComponent) {
        child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
      }
    }
    if (this.streamingComponent) {
      this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
    }
    this.ui.requestRender();
  }

  /**
   * Set an extension widget (string array or custom component).
   */
  private setExtensionWidget(
    key: string,
    content:
      | string[]
      | ((tui: TUI, thm: Theme) => Component & { dispose?(): void })
      | undefined,
    options?: ExtensionWidgetOptions,
  ): void {
    const placement = options?.placement ?? "aboveEditor";
    const removeExisting = (
      map: Map<string, Component & { dispose?(): void }>,
    ) => {
      const existing = map.get(key);
      if (existing?.dispose) existing.dispose();
      map.delete(key);
    };

    removeExisting(this.extensionWidgetsAbove);
    removeExisting(this.extensionWidgetsBelow);

    if (content === undefined) {
      this.renderWidgets();
      return;
    }

    let component: Component & { dispose?(): void };

    if (Array.isArray(content)) {
      // Wrap string array in a Container with Text components
      const container = new Container();
      for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
        container.addChild(new Text(line, 1, 0));
      }
      if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
        container.addChild(
          new Text(theme.fg("muted", "... (widget truncated)"), 1, 0),
        );
      }
      component = container;
    } else {
      // Factory function - create component
      component = content(this.ui, theme);
    }

    const targetMap =
      placement === "belowEditor"
        ? this.extensionWidgetsBelow
        : this.extensionWidgetsAbove;
    targetMap.set(key, component);
    this.renderWidgets();
  }

  private clearExtensionWidgets(): void {
    for (const widget of this.extensionWidgetsAbove.values()) {
      widget.dispose?.();
    }
    for (const widget of this.extensionWidgetsBelow.values()) {
      widget.dispose?.();
    }
    this.extensionWidgetsAbove.clear();
    this.extensionWidgetsBelow.clear();
    this.renderWidgets();
  }

  private resetExtensionUI(): void {
    if (this.extensionSelector) {
      this.hideExtensionSelector();
    }
    if (this.extensionInput) {
      this.hideExtensionInput();
    }
    if (this.extensionEditor) {
      this.hideExtensionEditor();
    }
    if (this.approvalDialogComponent) {
      this.hideApprovalDialog();
    }
    this.ui.hideOverlay();
    this.clearExtensionTerminalInputListeners();
    this.setExtensionFooter(undefined);
    this.setExtensionHeader(undefined);
    this.clearExtensionWidgets();
    this.footerDataProvider.clearExtensionStatuses();
    this.footer.invalidate();
    this.setCustomEditorComponent(undefined);
    this.defaultEditor.onExtensionShortcut = undefined;
    this.updateTerminalTitle();
    this.pendingWorkingMessage = undefined;
    this.setWorkingIndicator();
    if (this.loadingAnimation) {
      this.loadingAnimation.setMessage(
        `${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
      );
    }
    this.setHiddenThinkingLabel();
  }

  // Maximum total widget lines to prevent viewport overflow
  private static readonly MAX_WIDGET_LINES = 10;

  /**
   * Render all extension widgets to the widget container.
   */
  private renderWidgets(): void {
    if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
    this.renderWidgetContainer(
      this.widgetContainerAbove,
      this.extensionWidgetsAbove,
      true,
      true,
    );
    this.renderWidgetContainer(
      this.widgetContainerBelow,
      this.extensionWidgetsBelow,
      false,
      false,
    );
    this.ui.requestRender();
  }

  private renderWidgetContainer(
    container: Container,
    widgets: Map<string, Component & { dispose?(): void }>,
    spacerWhenEmpty: boolean,
    leadingSpacer: boolean,
  ): void {
    container.clear();

    if (widgets.size === 0) {
      if (spacerWhenEmpty) {
        container.addChild(new Spacer(1));
      }
      return;
    }

    if (leadingSpacer) {
      container.addChild(new Spacer(1));
    }
    for (const component of widgets.values()) {
      container.addChild(component);
    }
  }

  /**
   * Set a custom footer component, or restore the built-in footer.
   */
  private setExtensionFooter(
    factory:
      | ((
          tui: TUI,
          thm: Theme,
          footerData: ReadonlyFooterDataProvider,
        ) => Component & { dispose?(): void })
      | undefined,
  ): void {
    // Dispose existing custom footer
    if (this.customFooter?.dispose) {
      this.customFooter.dispose();
    }

    // Remove current footer from UI
    if (this.customFooter) {
      this.ui.removeChild(this.customFooter);
    } else {
      this.ui.removeChild(this.footer);
    }

    if (factory) {
      // Create and add custom footer, passing the data provider
      this.customFooter = factory(this.ui, theme, this.footerDataProvider);
      this.ui.addChild(this.customFooter);
    } else {
      // Restore built-in footer
      this.customFooter = undefined;
      this.ui.addChild(this.footer);
    }

    this.ui.requestRender();
  }

  /**
   * Set a custom header component, or restore the built-in header.
   */
  private setExtensionHeader(
    factory:
      ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
  ): void {
    // Header may not be initialized yet if called during early initialization
    if (!this.builtInHeader) {
      return;
    }

    // Dispose existing custom header
    if (this.customHeader?.dispose) {
      this.customHeader.dispose();
    }

    // Find the index of the current header in the header container
    const currentHeader = this.customHeader || this.builtInHeader;
    const index = this.headerContainer.children.indexOf(currentHeader);

    if (factory) {
      // Create and add custom header
      this.customHeader = factory(this.ui, theme);
      if (isExpandable(this.customHeader)) {
        this.customHeader.setExpanded(this.toolOutputExpanded);
      }
      if (index !== -1) {
        this.headerContainer.children[index] = this.customHeader;
      } else {
        // If not found (e.g. builtInHeader was never added), add at the top
        this.headerContainer.children.unshift(this.customHeader);
      }
    } else {
      // Restore built-in header
      this.customHeader = undefined;
      if (isExpandable(this.builtInHeader)) {
        this.builtInHeader.setExpanded(this.toolOutputExpanded);
      }
      if (index !== -1) {
        this.headerContainer.children[index] = this.builtInHeader;
      }
    }

    this.ui.requestRender();
  }

  private addExtensionTerminalInputListener(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void {
    const unsubscribe = this.ui.addInputListener(handler);
    this.extensionTerminalInputUnsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
    };
  }

  private clearExtensionTerminalInputListeners(): void {
    for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
      unsubscribe();
    }
    this.extensionTerminalInputUnsubscribers.clear();
  }

  /**
   * Create the ExtensionUIContext for extensions.
   */
  private createExtensionUIContext(): ExtensionUIContext {
    return {
      select: (title, options, opts) =>
        this.showExtensionSelector(title, options, opts),
      confirm: (title, message, opts) =>
        this.showExtensionConfirm(title, message, opts),
      input: (title, placeholder, opts) =>
        this.showExtensionInput(title, placeholder, opts),
      notify: (message, type) => this.showExtensionNotify(message, type),
      onTerminalInput: (handler) =>
        this.addExtensionTerminalInputListener(handler),
      setStatus: (key, text) => this.setExtensionStatus(key, text),
      setWorkingMessage: (message) => {
        if (this.loadingAnimation) {
          if (message) {
            this.loadingAnimation.setMessage(message);
          } else {
            this.loadingAnimation.setMessage(
              `${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
            );
          }
        } else {
          // Queue message for when loadingAnimation is created (handles agent_start race)
          this.pendingWorkingMessage = message;
        }
      },
      setWorkingIndicator: (options) => this.setWorkingIndicator(options),
      setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
      setWidget: (key, content, options) =>
        this.setExtensionWidget(key, content, options),
      setFooter: (factory) => this.setExtensionFooter(factory),
      setHeader: (factory) => this.setExtensionHeader(factory),
      setTitle: (title) => this.ui.terminal.setTitle(title),
      custom: (factory, options) => this.showExtensionCustom(factory, options),
      pasteToEditor: (text) =>
        this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      setEditorText: (text) => this.editor.setText(text),
      getEditorText: () =>
        this.editor.getExpandedText?.() ?? this.editor.getText(),
      editor: (title, prefill) => this.showExtensionEditor(title, prefill),
      setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
      get theme() {
        return theme;
      },
      getAllThemes: () => getAvailableThemesWithPaths(),
      getTheme: (name) => getThemeByName(name),
      setTheme: (themeOrName) => {
        if (themeOrName instanceof Theme) {
          setThemeInstance(themeOrName);
          this.ui.requestRender();
          return { success: true };
        }
        const result = setTheme(themeOrName, true);
        if (result.success) {
          if (this.settingsManager.getTheme() !== themeOrName) {
            this.settingsManager.setTheme(themeOrName);
          }
          this.ui.requestRender();
        }
        return result;
      },
      getToolsExpanded: () => this.toolOutputExpanded,
      setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
    };
  }

  /**
   * Show a selector for extensions.
   */
  private showExtensionSelector(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }

      const onAbort = () => {
        this.hideExtensionSelector();
        resolve(undefined);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      this.extensionSelector = new ExtensionSelectorComponent(
        title,
        options,
        (option) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(option);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(undefined);
        },
        { tui: this.ui, timeout: opts?.timeout },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionSelector);
      this.ui.setFocus(this.extensionSelector);
      this.ui.requestRender();
    });
  }

  /**
   * Hide the extension selector.
   */
  private hideExtensionSelector(): void {
    this.extensionSelector?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionSelector = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private showApprovalDialog(
    intentEventId: string,
    classification: IntentClassification,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    this.hideApprovalDialog();
    this.pendingApprovalEventId = intentEventId;
    this.approvalDialogComponent = new ApprovalDialogComponent(
      this.ui,
      classification,
      toolName,
      args,
      () => {
        const eid = this.pendingApprovalEventId;
        this.pendingApprovalEventId = undefined;
        this.hideApprovalDialog();
        if (eid) this.facade.runtime.approve(eid);
      },
      () => {
        const eid = this.pendingApprovalEventId;
        this.pendingApprovalEventId = undefined;
        this.hideApprovalDialog();
        if (eid) this.facade.runtime.reject(eid);
      },
    );
    // Render the approval dialog as a centered overlay ON TOP of the
    // existing UI (instead of swapping out the editor). This avoids the
    // full-screen flicker that clearing/re-adding the editor container
    // caused. The overlay captures keyboard focus for approve/reject.
    this.approvalOverlayHandle = this.ui.showOverlay(
      this.approvalDialogComponent,
      {
        anchor: "center",
        width: "60%",
        maxHeight: "70%",
        margin: 2,
      },
    );
    this.ui.requestRender();
  }

  private hideApprovalDialog(): void {
    const eid = this.pendingApprovalEventId;
    this.approvalDialogComponent?.dispose();
    this.approvalDialogComponent = undefined;
    this.pendingApprovalEventId = undefined;
    if (eid) {
      this.facade.runtime.reject(eid);
    }
    this.approvalOverlayHandle?.hide();
    this.approvalOverlayHandle = undefined;
    this.ui.requestRender();
  }

  /**
   * Show a confirmation dialog for extensions.
   */
  private async showExtensionConfirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    const result = await this.showExtensionSelector(
      `${title}\n${message}`,
      ["Yes", "No"],
      opts,
    );
    return result === "Yes";
  }

  private async promptForMissingSessionCwd(
    error: MissingSessionCwdError,
  ): Promise<string | undefined> {
    const confirmed = await this.showExtensionConfirm(
      "Session cwd not found",
      formatMissingSessionCwdPrompt(error.issue),
    );
    return confirmed ? error.issue.fallbackCwd : undefined;
  }

  /**
   * Show a text input for extensions.
   */
  private showExtensionInput(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }

      const onAbort = () => {
        this.hideExtensionInput();
        resolve(undefined);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      this.extensionInput = new ExtensionInputComponent(
        title,
        placeholder,
        (value) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(value);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(undefined);
        },
        { tui: this.ui, timeout: opts?.timeout },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionInput);
      this.ui.setFocus(this.extensionInput);
      this.ui.requestRender();
    });
  }

  /**
   * Hide the extension input.
   */
  private hideExtensionInput(): void {
    this.extensionInput?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionInput = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  /**
   * Show a multi-line editor for extensions (with Ctrl+G support).
   */
  private showExtensionEditor(
    title: string,
    prefill?: string,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.extensionEditor = new ExtensionEditorComponent(
        this.ui,
        this.keybindings,
        title,
        prefill,
        (value) => {
          this.hideExtensionEditor();
          resolve(value);
        },
        () => {
          this.hideExtensionEditor();
          resolve(undefined);
        },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionEditor);
      this.ui.setFocus(this.extensionEditor);
      this.ui.requestRender();
    });
  }

  /**
   * Hide the extension editor.
   */
  private hideExtensionEditor(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionEditor = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  /**
   * Set a custom editor component from an extension.
   * Pass undefined to restore the default editor.
   */
  private setCustomEditorComponent(
    factory:
      | ((
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
        ) => EditorComponent)
      | undefined,
  ): void {
    // Save text from current editor before switching
    const currentText = this.editor.getText();

    this.editorContainer.clear();

    if (factory) {
      // Create the custom editor with tui, theme, and keybindings
      const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

      // Wire up callbacks from the default editor
      newEditor.onSubmit = this.defaultEditor.onSubmit;
      newEditor.onChange = this.defaultEditor.onChange;

      // Copy text from previous editor
      newEditor.setText(currentText);

      // Copy appearance settings if supported
      if (newEditor.borderColor !== undefined) {
        newEditor.borderColor = this.defaultEditor.borderColor;
      }
      if (newEditor.setPaddingX !== undefined) {
        newEditor.setPaddingX(this.defaultEditor.getPaddingX());
      }

      // Set autocomplete if supported
      if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
        newEditor.setAutocompleteProvider(this.autocompleteProvider);
      }

      // If extending CustomEditor, copy app-level handlers
      // Use duck typing since instanceof fails across jiti module boundaries
      const customEditor = newEditor as unknown as Record<string, unknown>;
      if (
        "actionHandlers" in customEditor &&
        customEditor.actionHandlers instanceof Map
      ) {
        if (!customEditor.onEscape) {
          customEditor.onEscape = () => this.defaultEditor.onEscape?.();
        }
        if (!customEditor.onCtrlD) {
          customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
        }
        if (!customEditor.onPasteImage) {
          customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
        }
        if (!customEditor.onExtensionShortcut) {
          customEditor.onExtensionShortcut = (data: string) =>
            this.defaultEditor.onExtensionShortcut?.(data);
        }
        // Copy action handlers (clear, suspend, model switching, etc.)
        for (const [action, handler] of this.defaultEditor.actionHandlers) {
          (customEditor.actionHandlers as Map<string, () => void>).set(
            action,
            handler,
          );
        }
      }

      this.editor = newEditor;
    } else {
      // Restore default editor with text from custom editor
      this.defaultEditor.setText(currentText);
      this.editor = this.defaultEditor;
    }

    this.editorContainer.addChild(this.editor as Component);
    this.ui.setFocus(this.editor as Component);
    this.ui.requestRender();
  }

  /**
   * Show a notification for extensions.
   */
  private showExtensionNotify(
    message: string,
    type?: "info" | "warning" | "error",
  ): void {
    if (type === "error") {
      this.showError(message);
    } else if (type === "warning") {
      this.showWarning(message);
    } else {
      this.showStatus(message);
    }
  }

  /** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
  private async showExtensionCustom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) =>
      | (Component & { dispose?(): void })
      | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T> {
    const savedText = this.editor.getText();
    const isOverlay = options?.overlay ?? false;

    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.editor.setText(savedText);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    return new Promise((resolve, reject) => {
      let component: Component & { dispose?(): void };
      let closed = false;

      const close = (result: T) => {
        if (closed) return;
        closed = true;
        if (isOverlay) this.ui.hideOverlay();
        else restoreEditor();
        // Note: both branches above already call requestRender
        resolve(result);
        try {
          component?.dispose?.();
        } catch {
          /* ignore dispose errors */
        }
      };

      Promise.resolve(factory(this.ui, theme, this.keybindings, close))
        .then((c) => {
          if (closed) return;
          component = c;
          if (isOverlay) {
            // Resolve overlay options - can be static or dynamic function
            const resolveOptions = (): OverlayOptions | undefined => {
              if (options?.overlayOptions) {
                const opts =
                  typeof options.overlayOptions === "function"
                    ? options.overlayOptions()
                    : options.overlayOptions;
                return opts;
              }
              // Fallback: use component's width property if available
              const w = (component as { width?: number }).width;
              return w ? { width: w } : undefined;
            };
            const handle = this.ui.showOverlay(component, resolveOptions());
            // Expose handle to caller for visibility control
            options?.onHandle?.(handle);
          } else {
            this.editorContainer.clear();
            this.editorContainer.addChild(component);
            this.ui.setFocus(component);
            this.ui.requestRender();
          }
        })
        .catch((err) => {
          if (closed) return;
          if (!isOverlay) restoreEditor();
          reject(err);
        });
    });
  }

  /**
   * Show an extension error in the UI.
   */
  private showExtensionError(
    extensionPath: string,
    error: string,
    stack?: string,
  ): void {
    const errorMsg = `Extension "${extensionPath}" error: ${error}`;
    const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
    this.chatContainer.addChild(errorText);
    if (stack) {
      // Show stack trace in dim color, indented
      const stackLines = stack
        .split("\n")
        .slice(1) // Skip first line (duplicates error message)
        .map((line) => theme.fg("dim", `  ${line.trim()}`))
        .join("\n");
      if (stackLines) {
        this.chatContainer.addChild(new Text(stackLines, 1, 0));
      }
    }
    this.ui.requestRender();
  }

  // =========================================================================
  // Key Handlers
  // =========================================================================

  private setupKeyHandlers(): void {
    // Set up handlers on defaultEditor - they use this.editor for text access
    // so they work correctly regardless of which editor is active
    this.defaultEditor.onEscape = () => {
      if (this.loadingAnimation) {
        this.restoreQueuedMessagesToEditor({ abort: true });
      } else if (this.isBashRunningValue) {
        this.abortBashFacade();
      } else if (this.isBashMode) {
        this.editor.setText("");
        this.isBashMode = false;
        this.updateEditorBorderColor();
      } else if (!this.editor.getText().trim()) {
        // Double-escape with empty editor triggers /history or /rewind based on setting
        const action = this.settingsManager.getDoubleEscapeAction();
        if (action !== "none") {
          const now = Date.now();
          if (now - this.lastEscapeTime < 500) {
            if (action === "tree") {
              this.showTreeSelector();
            } else {
              this.showRewindSelector();
            }
            this.lastEscapeTime = 0;
          } else {
            this.lastEscapeTime = now;
          }
        }
      }
    };

    // Register app action handlers
    this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
    this.defaultEditor.onCtrlD = () => this.handleCtrlD();
    this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
    this.defaultEditor.onAction("app.thinking.cycle", () =>
      this.cycleThinkingLevel(),
    );
    this.defaultEditor.onAction("app.model.cycleForward", () =>
      this.cycleModel("forward"),
    );
    this.defaultEditor.onAction("app.model.cycleBackward", () =>
      this.cycleModel("backward"),
    );

    // Global debug handler on TUI (works regardless of focus)
    this.ui.onDebug = () => this.handleDebugCommand();
    this.defaultEditor.onAction("app.model.select", () =>
      this.showModelSelector(),
    );
    this.defaultEditor.onAction("app.tools.expand", () =>
      this.toggleToolOutputExpansion(),
    );
    this.defaultEditor.onAction("app.thinking.toggle", () =>
      this.toggleThinkingBlockVisibility(),
    );
    this.defaultEditor.onAction("app.editor.external", () =>
      this.openExternalEditor(),
    );
    this.defaultEditor.onAction("app.message.followUp", () =>
      this.handleFollowUp(),
    );
    this.defaultEditor.onAction("app.message.dequeue", () =>
      this.handleDequeue(),
    );

    this.defaultEditor.onChange = (text: string) => {
      const wasBashMode = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith("!");
      if (wasBashMode !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };

    // Handle clipboard image paste (triggered on Ctrl+V)
    this.defaultEditor.onPasteImage = () => {
      this.handleClipboardImagePaste();
    };
  }

  private async handleClipboardImagePaste(): Promise<void> {
    try {
      const image = await readClipboardImage();
      if (!image) {
        return;
      }

      // Write to temp file
      const tmpDir = os.tmpdir();
      const ext = extensionForImageMimeType(image.mimeType) ?? "png";
      const fileName = `pizza-clipboard-${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(image.bytes));

      // Insert file path directly
      this.editor.insertTextAtCursor?.(filePath);
      this.ui.requestRender();
    } catch {
      // Silently ignore clipboard errors (may not have permission, etc.)
    }
  }

  private setupEditorSubmitHandler(): void {
    this.defaultEditor.onSubmit = async (text: string) => {
      text = text.trim();
      if (!text) return;

      // Handle commands
      if (text === "/settings") {
        this.showSettingsSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/stats") {
        this.handleStatsCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/model" || text.startsWith("/model ")) {
        const searchTerm = text.startsWith("/model ")
          ? text.slice(7).trim()
          : undefined;
        this.editor.setText("");
        await this.handleModelCommand(searchTerm);
        return;
      }
      if (text === "/export" || text.startsWith("/export ")) {
        await this.handleExportCommand(text);
        this.editor.setText("");
        return;
      }
      if (text === "/share") {
        await this.handleShareCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/copy") {
        await this.handleCopyCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/hotkeys") {
        this.handleHotkeysCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/rewind") {
        this.showRewindSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/history") {
        this.showTreeSelector();
        this.editor.setText("");
        return;
      }
      if (text === "/login") {
        this.showOAuthSelector("login");
        this.editor.setText("");
        return;
      }
      if (text === "/logout") {
        this.showOAuthSelector("logout");
        this.editor.setText("");
        return;
      }
      if (text === "/compact" || text.startsWith("/compact ")) {
        const customInstructions = text.startsWith("/compact ")
          ? text.slice(9).trim()
          : undefined;
        this.editor.setText("");
        await this.handleCompactCommand(customInstructions);
        return;
      }
      if (text === "/reload") {
        this.editor.setText("");
        await this.handleReloadCommand();
        return;
      }
      if (text === "/debug") {
        this.handleDebugCommand();
        this.editor.setText("");
        return;
      }
      if (text === "/quit") {
        this.editor.setText("");
        await this.shutdown();
        return;
      }

      // Handle bash command (! for normal, !! for excluded from context)
      if (text.startsWith("!")) {
        const isExcluded = text.startsWith("!!");
        const command = isExcluded
          ? text.slice(2).trim()
          : text.slice(1).trim();
        if (command) {
          if (this.isBashRunningValue) {
            this.showWarning(
              "A bash command is already running. Press Esc to cancel it first.",
            );
            this.editor.setText(text);
            return;
          }
          this.editor.addToHistory?.(text);
          await this.handleBashCommand(command, isExcluded);
          this.isBashMode = false;
          this.updateEditorBorderColor();
          return;
        }
      }

      // Queue input during compaction (extension commands execute immediately)
      if (this.isCompacting) {
        if (this.isExtensionCommand(text)) {
          this.editor.addToHistory?.(text);
          this.editor.setText("");
          await this.promptFacadeOrSession(text);
        } else {
          this.queueCompactionMessage(text, "steer");
        }
        return;
      }

      // If streaming, use prompt() with steer behavior
      // This handles extension commands (execute immediately), prompt template expansion, and queueing
      if (this.isStreaming) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        await this.facade.steer(text);
        this.updatePendingMessagesDisplay();
        this.ui.requestRender();
        return;
      }

      // Normal message submission
      // First, move any pending bash components to chat
      this.flushPendingBashComponents();

      if (this.onInputCallback) {
        this.onInputCallback(text);
      }
      this.editor.addToHistory?.(text);
    };
  }

  /**
   * Prompt via facade or session, depending on mode.
   */
  private async promptFacadeOrSession(
    text: string,
    images?: ImageContent[],
  ): Promise<void> {
    return this.facade.prompt(text, images as any);
  }
  private subscribeToAgent(): void {
    this.subscribeToFacade();
  }

  /**
   * Subscribe to SessionFacade events (TypedEvent → ModeEvent).
   */
  private subscribeToFacade(): void {
    this.unsubscribe = this.facade!.subscribe(async (event) => {
      const modeEvents = mapTypedEventToModeEvents(event);
      for (const modeEvent of modeEvents) {
        await this.handleModeEvent(modeEvent);
      }
    });
  }

  /**
   * Handle ModeEvent (converted from TypedEvent via ModeEventMapper).
   */
  private async handleModeEvent(event: ModeEvent): Promise<void> {
    if (!this.isInitialized) {
      await this.init();
    }
    this.footer.invalidate();

    switch (event.type) {
      case "turn_started": {
        this._isStreaming = true;
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }
        if (this.retryCountdown) {
          this.retryCountdown.dispose();
          this.retryCountdown = undefined;
        }
        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
        }
        if (this.loadingAnimation) {
          this.loadingAnimation.stop();
        }
        this.statusContainer.clear();
        this.loadingAnimation = new Loader(
          this.ui,
          (spinner) => theme.fg("accent", spinner),
          (text) => theme.fg("muted", text),
          this.defaultWorkingMessage,
          this.workingIndicatorOptions,
        );
        this.statusContainer.addChild(this.loadingAnimation);
        if (this.pendingWorkingMessage !== undefined) {
          if (this.pendingWorkingMessage) {
            this.loadingAnimation.setMessage(this.pendingWorkingMessage);
          }
          this.pendingWorkingMessage = undefined;
        }
        this.ui.requestRender();
        break;
      }

      case "turn_completed": {
        this._isStreaming = false;
        this._retryAttempt = 0;
        if (this.loadingAnimation) {
          this.loadingAnimation.stop();
          this.loadingAnimation = undefined;
          this.statusContainer.clear();
        }
        if (this.streamingComponent) {
          this.chatContainer.removeChild(this.streamingComponent);
          this.streamingComponent = undefined;
          this.streamingMessage = undefined;
        }
        this.pendingTools.clear();
        // Surface loop detection to the user so they know why the agent stopped.
        if (event.reason === "loop_detected") {
          this.showStatus(
            "Agent stopped: repeated identical tool calls detected (possible loop). Send a message to continue.",
          );
        }
        await this.checkShutdownRequested();
        this.ui.requestRender();
        break;
      }

      case "message_committed": {
        const msg = event.message;
        // bashExecution messages are already rendered by handleBashCommand;
        // skip here to avoid duplicate display from the BASH_EXECUTION event.
        if (msg.role === "bashExecution") {
          break;
        }
        if (msg.role === "user") {
          this.addMessageToChat(msg);
          this.updatePendingMessagesDisplay();
        } else if (msg.role === "assistant") {
          if (this.streamingComponent) {
            this.streamingMessage = msg as AssistantMessage;
            this.streamingComponent.updateContent(this.streamingMessage);

            if (
              this.streamingMessage.stopReason === "aborted" ||
              this.streamingMessage.stopReason === "error"
            ) {
              let errorMessage: string | undefined;
              if (this.streamingMessage.stopReason === "aborted") {
                errorMessage =
                  this._retryAttempt > 0
                    ? `Aborted after ${this._retryAttempt} retry attempt${this._retryAttempt > 1 ? "s" : ""}`
                    : "Operation aborted";
                this.streamingMessage.errorMessage = errorMessage;
              }
              this.streamingComponent.updateContent(this.streamingMessage);

              for (const [, component] of this.pendingTools.entries()) {
                component.updateResult({
                  content: [{ type: "text", text: errorMessage ?? "Error" }],
                  isError: true,
                });
              }
              this.pendingTools.clear();
            } else {
              for (const content of (msg as AssistantMessage).content) {
                if (content.type === "toolCall") {
                  const component = this.pendingTools.get(content.id);
                  if (component) {
                    component.updateToolCall(
                      content.name,
                      content.arguments,
                      this.getRegisteredToolDefinition(content.name),
                    );
                    component.setArgsComplete();
                  }
                }
              }
            }
            if (this.streamingMessage.stopReason === "length")
              this.showStatus(
                "Response truncated (max tokens reached). Type continue to resume.",
              );
            this.streamingComponent = undefined;
            this.streamingMessage = undefined;
            this.footer.invalidate();
          } else {
            // Non-streaming message commit (e.g., user, compaction summary, bash, custom)
            this.addMessageToChat(msg);
          }
        } else {
          // Other roles: bash, custom, compaction summary, branch summary
          this.addMessageToChat(msg);
        }
        this.ui.requestRender();
        break;
      }

      case "streaming_message_started": {
        this._streamingText = "";
        this.streamingComponent = new AssistantMessageComponent(
          undefined,
          this.hideThinkingBlock,
          this.getMarkdownThemeWithSettings(),
          this.hiddenThinkingLabel,
        );
        this.streamingMessage = undefined;
        this.chatContainer.addChild(this.streamingComponent);
        this.ui.requestRender();
        break;
      }

      case "streaming_message_updated": {
        if (event.delta) {
          this._streamingText += event.delta;
          // Re-render the streaming component with accumulated text
          if (this.streamingComponent) {
            const streamingMsg = {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: this._streamingText }],
              stopReason: null as any,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            } as AssistantMessage;
            this.streamingComponent.updateContent(streamingMsg);
          }
        }
        this.ui.requestRender();
        break;
      }

      case "tool_started": {
        let component = this.pendingTools.get(event.toolCallId);
        if (!component) {
          component = new ToolExecutionComponent(
            event.toolName,
            event.toolCallId,
            event.args,
            {
              showImages: this.settingsManager.getShowImages(),
              imageWidthCells: this.settingsManager.getImageWidthCells(),
            },
            this.getRegisteredToolDefinition(event.toolName),
            this.ui,
            this.facadeCwd,
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
          this.pendingTools.set(event.toolCallId, component);
        } else {
          component.updateToolCall(
            event.toolName,
            event.args,
            this.getRegisteredToolDefinition(event.toolName),
          );
        }
        component.markExecutionStarted();
        this.ui.requestRender();
        break;
      }

      case "tool_updated": {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult(
            { content: [{ type: "text", text: event.update }], isError: false },
            true,
          );
          this.ui.requestRender();
        }
        break;
      }

      case "tool_finished": {
        const toolComponent = this.pendingTools.get(event.toolCallId);
        if (toolComponent) {
          const content = Array.isArray(event.result)
            ? (event.result as Array<{
                type: string;
                text?: string;
                data?: string;
                mimeType?: string;
              }>)
            : [{ type: "text", text: String(event.result) }];
          toolComponent.updateResult({
            content,
            details: event.details,
            isError: event.isError,
          });
          this.pendingTools.delete(event.toolCallId);
          this.ui.requestRender();
        }
        break;
      }

      case "compaction_started": {
        this._isCompacting = true;
        this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          this.facade!.runtime.abort();
        };
        this.statusContainer.clear();
        const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
        const label = `Auto-compacting... ${cancelHint}`;
        this.autoCompactionLoader = new Loader(
          this.ui,
          (spinner) => theme.fg("accent", spinner),
          (text) => theme.fg("muted", text),
          label,
        );
        this.statusContainer.addChild(this.autoCompactionLoader);
        this.ui.requestRender();
        break;
      }

      case "compaction_finished": {
        this._isCompacting = false;
        if (this.autoCompactionEscapeHandler) {
          this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
          this.autoCompactionEscapeHandler = undefined;
        }
        if (this.autoCompactionLoader) {
          this.autoCompactionLoader.stop();
          this.autoCompactionLoader = undefined;
          this.statusContainer.clear();
        }
        // Rebuild chat from projection
        this.chatContainer.clear();
        this.rebuildChatFromMessages();
        this.addMessageToChat(
          createCompactionSummaryMessage(
            event.summary,
            event.tokensBefore,
            new Date().toISOString(),
          ),
        );
        this.footer.invalidate();
        void this.flushCompactionQueue({ willRetry: false });
        this.ui.requestRender();
        break;
      }

      case "compaction_aborted": {
        this._isCompacting = false;
        if (this.autoCompactionEscapeHandler) {
          this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
          this.autoCompactionEscapeHandler = undefined;
        }
        if (this.autoCompactionLoader) {
          this.autoCompactionLoader.stop();
          this.autoCompactionLoader = undefined;
          this.statusContainer.clear();
        }
        this.showStatus("Auto-compaction cancelled");
        void this.flushCompactionQueue({ willRetry: false });
        this.ui.requestRender();
        break;
      }

      case "retry_scheduled": {
        this._retryAttempt = event.attempt;
        this.retryEscapeHandler = this.defaultEditor.onEscape;
        this.defaultEditor.onEscape = () => {
          // Emit RETRY_ABORTED
          this.facade!.abort();
        };
        this.statusContainer.clear();
        this.retryCountdown?.dispose();
        const retryMessage = (seconds: number) =>
          `Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
        this.retryLoader = new Loader(
          this.ui,
          (spinner) => theme.fg("warning", spinner),
          (text) => theme.fg("muted", text),
          retryMessage(Math.ceil(event.delayMs / 1000)),
        );
        this.retryCountdown = new CountdownTimer(
          event.delayMs,
          this.ui,
          (seconds) => {
            this.retryLoader?.setMessage(retryMessage(seconds));
          },
          () => {
            this.retryCountdown = undefined;
          },
        );
        this.statusContainer.addChild(this.retryLoader);
        this.ui.requestRender();
        break;
      }

      case "retry_aborted": {
        if (this.retryEscapeHandler) {
          this.defaultEditor.onEscape = this.retryEscapeHandler;
          this.retryEscapeHandler = undefined;
        }
        if (this.retryCountdown) {
          this.retryCountdown.dispose();
          this.retryCountdown = undefined;
        }
        if (this.retryLoader) {
          this.retryLoader.stop();
          this.retryLoader = undefined;
          this.statusContainer.clear();
        }
        this.ui.requestRender();
        break;
      }

      case "model_changed":
      case "thinking_level_changed": {
        this.footer.invalidate();
        this.updateEditorBorderColor();
        this.ui.requestRender();
        break;
      }

      case "runtime_error":
      case "agent_error": {
        this.showError(event.error);
        this.ui.requestRender();
        break;
      }

      case "session_split": {
        this.chatContainer.addChild(new Spacer(1));
        const reasonLabel = event.reason.replace(/_/g, " ");
        const separator = `── Session split: ${reasonLabel} ──`;
        this.chatContainer.addChild(
          new Text(theme.fg("accent", separator), 1, 0),
        );
        this.chatContainer.addChild(new Spacer(1));
        this.ui.requestRender();
        break;
      }
    }
  }
  /** Extract text content from a user message */
  private getUserMessageText(message: Message): string {
    if (message.role !== "user") return "";
    const textBlocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.filter((c: { type: string }) => c.type === "text");
    return textBlocks.map((c) => (c as { text: string }).text).join("");
  }

  /**
   * Show a status message in the chat.
   *
   * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
   * we update the previous status line instead of appending new ones to avoid log spam.
   */
  private showStatus(message: string): void {
    const children = this.chatContainer.children;
    const last =
      children.length > 0 ? children[children.length - 1] : undefined;
    const secondLast =
      children.length > 1 ? children[children.length - 2] : undefined;

    if (
      last &&
      secondLast &&
      last === this.lastStatusText &&
      secondLast === this.lastStatusSpacer
    ) {
      this.lastStatusText.setText(theme.fg("dim", message));
      this.ui.requestRender();
      return;
    }

    const spacer = new Spacer(1);
    const text = new Text(theme.fg("dim", message), 1, 0);
    this.chatContainer.addChild(spacer);
    this.chatContainer.addChild(text);
    this.lastStatusSpacer = spacer;
    this.lastStatusText = text;
    this.ui.requestRender();
  }

  private addMessageToChat(
    message: AgentMessage,
    options?: { populateHistory?: boolean },
  ): void {
    switch (message.role) {
      case "bashExecution": {
        const component = new BashExecutionComponent(
          message.command,
          this.ui,
          message.excludeFromContext,
        );
        if (message.output) {
          component.appendOutput(message.output);
        }
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated
            ? ({ truncated: true } as TruncationResult)
            : undefined,
          message.fullOutputPath,
        );
        this.chatContainer.addChild(component);
        break;
      }
      case "custom": {
        if (message.display) {
          const renderer = this.extensionRunnerValue.getMessageRenderer(
            message.customType,
          );
          const component = new CustomMessageComponent(
            message,
            renderer,
            this.getMarkdownThemeWithSettings(),
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
        }
        break;
      }
      case "compactionSummary": {
        this.chatContainer.addChild(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(
          message,
          this.getMarkdownThemeWithSettings(),
        );
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case "branchSummary": {
        this.chatContainer.addChild(new Spacer(1));
        const component = new BranchSummaryMessageComponent(
          message,
          this.getMarkdownThemeWithSettings(),
        );
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case "user": {
        const textContent = this.getUserMessageText(message);
        if (textContent) {
          if (!this.isFirstUserMessage) {
            this.chatContainer.addChild(new Spacer(1));
          }
          const skillBlock = parseSkillBlock(textContent);
          if (skillBlock) {
            // Render skill block (collapsible)
            const component = new SkillInvocationMessageComponent(
              skillBlock,
              this.getMarkdownThemeWithSettings(),
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            // Render user message separately if present
            if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(
                skillBlock.userMessage,
                this.getMarkdownThemeWithSettings(),
              );
              this.chatContainer.addChild(userComponent);
            }
          } else {
            const userComponent = new UserMessageComponent(
              textContent,
              this.getMarkdownThemeWithSettings(),
            );
            this.chatContainer.addChild(userComponent);
          }
          this.isFirstUserMessage = false;
          if (options?.populateHistory) {
            this.editor.addToHistory?.(textContent);
          }
        }
        break;
      }
      case "assistant": {
        const assistantComponent = new AssistantMessageComponent(
          message,
          this.hideThinkingBlock,
          this.getMarkdownThemeWithSettings(),
          this.hiddenThinkingLabel,
        );
        this.chatContainer.addChild(assistantComponent);
        break;
      }
      case "toolResult": {
        // Tool results are rendered inline with tool calls, handled separately
        break;
      }
      default: {
        const _exhaustive: never = message;
      }
    }
  }

  /**
   * Render session context to chat. Used for initial load and rebuild after compaction.
   * @param sessionContext Session context to render
   * @param options.updateFooter Update footer state
   * @param options.populateHistory Add user messages to editor history
   */
  private renderSessionContext(
    sessionContext: { messages: AgentMessage[] },
    options: { updateFooter?: boolean; populateHistory?: boolean } = {},
  ): void {
    this.pendingTools.clear();
    this.isFirstUserMessage = true;

    if (options.updateFooter) {
      this.footer.invalidate();
      this.updateEditorBorderColor();
    }

    for (const message of sessionContext.messages) {
      // Assistant messages need special handling for tool calls
      if (message.role === "assistant") {
        this.addMessageToChat(message);
        // Render tool call components
        for (const content of message.content) {
          if (content.type === "toolCall") {
            const component = new ToolExecutionComponent(
              content.name,
              content.id,
              content.arguments,
              {
                showImages: this.settingsManager.getShowImages(),
                imageWidthCells: this.settingsManager.getImageWidthCells(),
              },
              this.getRegisteredToolDefinition(content.name),
              this.ui,
              this.facadeCwd,
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);

            if (
              message.stopReason === "aborted" ||
              message.stopReason === "error"
            ) {
              let errorMessage: string;
              if (message.stopReason === "aborted") {
                const retryAttempt = this.retryAttemptValue;
                errorMessage =
                  retryAttempt > 0
                    ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
                    : "Operation aborted";
              } else {
                errorMessage = message.errorMessage || "Error";
              }
              component.updateResult({
                content: [{ type: "text", text: errorMessage }],
                isError: true,
              });
            } else {
              this.pendingTools.set(content.id, component);
            }
          }
        }
        if (message.stopReason === "length")
          this.showStatus("Response truncated (max tokens reached).");
      } else if (message.role === "toolResult") {
        // Match tool results to pending tool components
        const component = this.pendingTools.get(message.toolCallId);
        if (component) {
          component.updateResult(message);
          this.pendingTools.delete(message.toolCallId);
        }
      } else {
        // All other messages use standard rendering
        this.addMessageToChat(message, options);
      }
    }

    this.pendingTools.clear();
    this.ui.requestRender();
  }

  renderInitialMessages(): void {
    // Get aligned messages and entries from session context
    const context = this.facade.getProjection().buildContext();
    this.renderSessionContext(context, {
      updateFooter: true,
      populateHistory: true,
    });

    // Show compaction info if session was compacted
    const allEntries = this.facade.getProjection().getTimeline();
    const compactionCount = allEntries.filter(
      (e: any) => e.kind === "compaction",
    ).length;
    if (compactionCount > 0) {
      const times =
        compactionCount === 1 ? "1 time" : `${compactionCount} times`;
      this.showStatus(`Session compacted ${times}`);
    }
  }

  async getUserInput(): Promise<string> {
    return new Promise((resolve) => {
      this.onInputCallback = (text: string) => {
        this.onInputCallback = undefined;
        resolve(text);
      };
    });
  }

  private rebuildChatFromMessages(): void {
    this.chatContainer.clear();
    const context = this.facade.getProjection().buildContext();
    this.renderSessionContext(context);
  }

  // =========================================================================
  // Key handlers
  // =========================================================================

  private handleCtrlC(): void {
    const now = Date.now();
    if (now - this.lastSigintTime < 500) {
      void this.shutdown();
    } else {
      this.clearEditor();
      this.lastSigintTime = now;
    }
  }

  private handleCtrlD(): void {
    // Only called when editor is empty (enforced by CustomEditor)
    void this.shutdown();
  }

  /**
   * Gracefully shutdown the agent.
   * Emits shutdown event to extensions, then exits.
   */
  private isShuttingDown = false;

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.facade.dispose();

    // Wait for any pending renders to complete
    // requestRender() uses process.nextTick(), so we wait one tick
    await new Promise((resolve) => process.nextTick(resolve));

    // Drain any in-flight Kitty key release events before stopping.
    // This prevents escape sequences from leaking to the parent shell over slow SSH.
    await this.ui.terminal.drainInput(1000);

    this.stop();
    process.exit(0);
  }

  /**
   * Check if shutdown was requested and perform shutdown if so.
   */
  private async checkShutdownRequested(): Promise<void> {
    if (!this.shutdownRequested) return;
    await this.shutdown();
  }

  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ["SIGTERM"];
    if (process.platform !== "win32") {
      signals.push("SIGHUP");
    }

    for (const signal of signals) {
      const handler = () => {
        killTrackedDetachedChildren();
        void this.shutdown();
      };
      process.on(signal, handler);
      this.signalCleanupHandlers.push(() => process.off(signal, handler));
    }
  }

  private unregisterSignalHandlers(): void {
    for (const cleanup of this.signalCleanupHandlers) {
      cleanup();
    }
    this.signalCleanupHandlers = [];
  }

  private handleCtrlZ(): void {
    if (process.platform === "win32") {
      this.showStatus("Suspend to background is not supported on Windows");
      return;
    }

    // Keep the event loop alive while suspended. Without this, stopping the TUI
    // can leave Node with no ref'ed handles, causing the process to exit on fg
    // before the SIGCONT handler gets a chance to restore the terminal.
    const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

    // Ignore SIGINT while suspended so Ctrl+C in the terminal does not
    // kill the backgrounded process. The handler is removed on resume.
    const ignoreSigint = () => {};
    process.on("SIGINT", ignoreSigint);

    // Set up handler to restore TUI when resumed
    process.once("SIGCONT", () => {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      this.ui.start();
      this.ui.requestRender(true);
    });

    try {
      // Stop the TUI (restore terminal to normal mode)
      this.ui.stop();

      // Send SIGTSTP to process group (pid=0 means all processes in group)
      process.kill(0, "SIGTSTP");
    } catch (error) {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      throw error;
    }
  }

  private async handleFollowUp(): Promise<void> {
    const text = (
      this.editor.getExpandedText?.() ?? this.editor.getText()
    ).trim();
    if (!text) return;

    // Queue input during compaction (extension commands execute immediately)
    if (this.isCompacting) {
      if (this.isExtensionCommand(text)) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        await this.promptFacadeOrSession(text);
      } else {
        this.queueCompactionMessage(text, "followUp");
      }
      return;
    }

    // Alt+Enter queues a follow-up message (waits until agent finishes)
    // This handles extension commands (execute immediately), prompt template expansion, and queueing
    if (this.isStreaming) {
      this.editor.addToHistory?.(text);
      this.editor.setText("");
      await this.facade.followUp(text);
      this.updatePendingMessagesDisplay();
      this.ui.requestRender();
    }
    // If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
    else if (this.editor.onSubmit) {
      this.editor.onSubmit(text);
    }
  }

  private handleDequeue(): void {
    const restored = this.restoreQueuedMessagesToEditor();
    if (restored === 0) {
      this.showStatus("No queued messages to restore");
    } else {
      this.showStatus(
        `Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`,
      );
    }
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = theme.getBashModeBorderColor();
    } else {
      const level = this.currentThinkingLevel || "off";
      this.editor.borderColor = theme.getThinkingBorderColor(level);
    }
    this.ui.requestRender();
  }

  private cycleThinkingLevel(): void {
    const newLevel = this.cycleThinkingLevelFacade();
    if (newLevel === undefined) {
      this.showStatus("Current model does not support thinking");
    } else {
      this.footer.invalidate();
      this.updateEditorBorderColor();
      this.showStatus(`Thinking level: ${newLevel}`);
    }
  }

  private async cycleModel(direction: "forward" | "backward"): Promise<void> {
    try {
      const result = await this.cycleModelFacade(direction);
      if (result === undefined) {
        this.showStatus("Only one model available");
      } else {
        this.footer.invalidate();
        this.updateEditorBorderColor();
        const thinkingStr =
          result.model.reasoning && result.thinkingLevel !== "off"
            ? ` (thinking: ${result.thinkingLevel})`
            : "";
        this.showStatus(
          `Switched to ${result.model.name || result.model.id}${thinkingStr}`,
        );
        void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private toggleToolOutputExpansion(): void {
    this.setToolsExpanded(!this.toolOutputExpanded);
  }

  private setToolsExpanded(expanded: boolean): void {
    this.toolOutputExpanded = expanded;
    const activeHeader = this.customHeader ?? this.builtInHeader;
    if (isExpandable(activeHeader)) {
      activeHeader.setExpanded(expanded);
    }
    for (const child of this.chatContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(expanded);
      }
    }
    this.ui.requestRender();
  }

  private toggleThinkingBlockVisibility(): void {
    this.hideThinkingBlock = !this.hideThinkingBlock;
    this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

    // Rebuild chat from session messages
    this.chatContainer.clear();
    this.rebuildChatFromMessages();

    // If streaming, re-add the streaming component with updated visibility and re-render
    if (this.streamingComponent && this.streamingMessage) {
      this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
      this.streamingComponent.updateContent(this.streamingMessage);
      this.chatContainer.addChild(this.streamingComponent);
    }

    this.showStatus(
      `Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`,
    );
  }

  private openExternalEditor(): void {
    // Determine editor (respect $VISUAL, then $EDITOR)
    const editorCmd = process.env.VISUAL || process.env.EDITOR;
    if (!editorCmd) {
      this.showWarning(
        "No editor configured. Set $VISUAL or $EDITOR environment variable.",
      );
      return;
    }

    const currentText =
      this.editor.getExpandedText?.() ?? this.editor.getText();
    const tmpFile = path.join(
      os.tmpdir(),
      `pizza-editor-${Date.now()}.pizza.md`,
    );

    try {
      // Write current content to temp file
      fs.writeFileSync(tmpFile, currentText, "utf-8");

      // Stop TUI to release terminal
      this.ui.stop();

      // Split by space to support editor arguments (e.g., "code --wait")
      const [editor, ...editorArgs] = editorCmd.split(" ");

      // Spawn editor synchronously with inherited stdio for interactive editing
      const result = spawnSync(editor, [...editorArgs, tmpFile], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });

      // On successful exit (status 0), replace editor content
      if (result.status === 0) {
        const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
        this.editor.setText(newContent);
      }
      // On non-zero exit, keep original text (no action needed)
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }

      // Restart TUI
      this.ui.start();
      // Force full re-render since external editor uses alternate screen
      this.ui.requestRender(true);
    }
  }

  // =========================================================================
  // UI helpers
  // =========================================================================

  clearEditor(): void {
    this.editor.setText("");
    this.ui.requestRender();
  }

  showError(errorMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0),
    );
    this.ui.requestRender();
  }

  showWarning(warningMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0),
    );
    this.ui.requestRender();
  }

  /**
   * Show a non-fatal update-available notice in the chat stream. Called
   * asynchronously after startup by the auto update check in main.ts — must
   * never throw or block.
   */
  showUpdateNotice(notice: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(theme.fg("success", notice), 1, 0),
    );
    this.ui.requestRender();
  }

  private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
    return {
      steering: [
        ...this.getSteeringMessagesFacade(),
        ...this.compactionQueuedMessages
          .filter((msg) => msg.mode === "steer")
          .map((msg) => msg.text),
      ],
      followUp: [
        ...this.getFollowUpMessagesFacade(),
        ...this.compactionQueuedMessages
          .filter((msg) => msg.mode === "followUp")
          .map((msg) => msg.text),
      ],
    };
  }

  /**
   * Clear all queued messages and return their contents.
   * Clears both session queue and compaction queue.
   */
  private clearAllQueues(): { steering: string[]; followUp: string[] } {
    const { steering, followUp } = this.clearQueueFacade();
    const compactionSteering = this.compactionQueuedMessages
      .filter((msg) => msg.mode === "steer")
      .map((msg) => msg.text);
    const compactionFollowUp = this.compactionQueuedMessages
      .filter((msg) => msg.mode === "followUp")
      .map((msg) => msg.text);
    this.compactionQueuedMessages = [];
    return {
      steering: [...steering, ...compactionSteering],
      followUp: [...followUp, ...compactionFollowUp],
    };
  }

  private updatePendingMessagesDisplay(): void {
    this.pendingMessagesContainer.clear();
    const { steering: steeringMessages, followUp: followUpMessages } =
      this.getAllQueuedMessages();
    if (steeringMessages.length > 0 || followUpMessages.length > 0) {
      this.pendingMessagesContainer.addChild(new Spacer(1));
      for (const message of steeringMessages) {
        const text = theme.fg("dim", `Steering: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      for (const message of followUpMessages) {
        const text = theme.fg("dim", `Follow-up: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
      const hintText = theme.fg(
        "dim",
        `↳ ${dequeueHint} to edit all queued messages`,
      );
      this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
    }
  }

  private restoreQueuedMessagesToEditor(options?: {
    abort?: boolean;
    currentText?: string;
  }): number {
    const { steering, followUp } = this.clearAllQueues();
    const allQueued = [...steering, ...followUp];
    if (allQueued.length === 0) {
      this.updatePendingMessagesDisplay();
      if (options?.abort) {
        this.facade.abort();
      }
      return 0;
    }
    const queuedText = allQueued.join("\n\n");
    const currentText = options?.currentText ?? this.editor.getText();
    const combinedText = [queuedText, currentText]
      .filter((t) => t.trim())
      .join("\n\n");
    this.editor.setText(combinedText);
    this.updatePendingMessagesDisplay();
    if (options?.abort) {
      this.facade.abort();
    }
    return allQueued.length;
  }

  private queueCompactionMessage(
    text: string,
    mode: "steer" | "followUp",
  ): void {
    this.compactionQueuedMessages.push({ text, mode });
    this.editor.addToHistory?.(text);
    this.editor.setText("");
    this.updatePendingMessagesDisplay();
    this.showStatus("Queued message for after compaction");
  }

  private isExtensionCommand(text: string): boolean {
    if (!text.startsWith("/")) return false;

    const extensionRunner = this.extensionRunnerValue;

    const spaceIndex = text.indexOf(" ");
    const commandName =
      spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return !!extensionRunner.getCommand(commandName);
  }

  private async flushCompactionQueue(options?: {
    willRetry?: boolean;
  }): Promise<void> {
    if (this.compactionQueuedMessages.length === 0) {
      return;
    }

    const queuedMessages = [...this.compactionQueuedMessages];
    this.compactionQueuedMessages = [];
    this.updatePendingMessagesDisplay();

    const restoreQueue = (error: unknown) => {
      this.clearQueueFacade();
      this.compactionQueuedMessages = queuedMessages;
      this.updatePendingMessagesDisplay();
      this.showError(
        `Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    };

    try {
      if (options?.willRetry) {
        // When retry is pending, queue messages for the retry turn
        for (const message of queuedMessages) {
          if (this.isExtensionCommand(message.text)) {
            await this.promptFacadeOrSession(message.text);
          } else if (message.mode === "followUp") {
            await this.facade.followUp(message.text);
          } else {
            await this.facade.steer(message.text);
          }
        }
        this.updatePendingMessagesDisplay();
        return;
      }

      // Find first non-extension-command message to use as prompt
      const firstPromptIndex = queuedMessages.findIndex(
        (message) => !this.isExtensionCommand(message.text),
      );
      if (firstPromptIndex === -1) {
        // All extension commands - execute them all
        for (const message of queuedMessages) {
          await this.promptFacadeOrSession(message.text);
        }
        return;
      }

      // Execute any extension commands before the first prompt
      const preCommands = queuedMessages.slice(0, firstPromptIndex);
      const firstPrompt = queuedMessages[firstPromptIndex];
      const rest = queuedMessages.slice(firstPromptIndex + 1);

      for (const message of preCommands) {
        await this.promptFacadeOrSession(message.text);
      }

      // Send first prompt (starts streaming)
      const promptPromise = this.promptFacadeOrSession(firstPrompt.text).catch(
        (error) => {
          restoreQueue(error);
        },
      );

      // Queue remaining messages
      for (const message of rest) {
        if (this.isExtensionCommand(message.text)) {
          await this.promptFacadeOrSession(message.text);
        } else if (message.mode === "followUp") {
          await this.facade.followUp(message.text);
        } else {
          await this.facade.steer(message.text);
        }
      }
      this.updatePendingMessagesDisplay();
      void promptPromise;
    } catch (error) {
      restoreQueue(error);
    }
  }

  /** Move pending bash components from pending area to chat */
  private flushPendingBashComponents(): void {
    for (const component of this.pendingBashComponents) {
      this.pendingMessagesContainer.removeChild(component);
      this.chatContainer.addChild(component);
    }
    this.pendingBashComponents = [];
  }

  // =========================================================================
  // Selectors
  // =========================================================================

  /**
   * Shows a selector component in place of the editor.
   * @param create Factory that receives a `done` callback and returns the component and focus target
   */
  private showSelector(
    create: (done: () => void) => { component: Component; focus: Component },
  ): void {
    const done = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
    };
    const { component, focus } = create(done);
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ui.setFocus(focus);
    this.ui.requestRender();
  }

  private showSettingsSelector(): void {
    this.showSelector((done) => {
      const selector = new SettingsSelectorComponent(
        {
          autoCompact: this.autoCompactionEnabled,
          showImages: this.settingsManager.getShowImages(),
          imageWidthCells: this.settingsManager.getImageWidthCells(),
          autoResizeImages: this.settingsManager.getImageAutoResize(),
          blockImages: this.settingsManager.getBlockImages(),
          enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
          builtinSkills: getBuiltinSkillInfos().map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            enabled: this.settingsManager.getEnabledBuiltinSkills().has(skill.id),
          })),
          transport: this.settingsManager.getTransport(),
          thinkingLevel: this.currentThinkingLevel,
          availableThinkingLevels: this.getAvailableThinkingLevelsFacade(),
          currentTheme: this.settingsManager.getTheme() || "dark",
          availableThemes: getAvailableThemes(),
          hideThinkingBlock: this.hideThinkingBlock,
          collapseChangelog: this.settingsManager.getCollapseChangelog(),
          enableInstallTelemetry:
            this.settingsManager.getEnableInstallTelemetry(),
          doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
          treeFilterMode: this.settingsManager.getTreeFilterMode(),
          showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
          editorPaddingX: this.settingsManager.getEditorPaddingX(),
          autocompleteMaxVisible:
            this.settingsManager.getAutocompleteMaxVisible(),
          quietStartup: this.settingsManager.getQuietStartup(),
          clearOnShrink: this.settingsManager.getClearOnShrink(),
          safeMode: this.settingsManager.getSafeMode(),
        },
        {
          onAutoCompactChange: (enabled) => {
            this.setAutoCompactionEnabledFacade(enabled);
            this.footer.setAutoCompactEnabled(enabled);
          },
          onShowImagesChange: (enabled) => {
            this.settingsManager.setShowImages(enabled);
            for (const child of this.chatContainer.children) {
              if (child instanceof ToolExecutionComponent) {
                child.setShowImages(enabled);
              }
            }
          },
          onImageWidthCellsChange: (width) => {
            this.settingsManager.setImageWidthCells(width);
            for (const child of this.chatContainer.children) {
              if (child instanceof ToolExecutionComponent) {
                child.setImageWidthCells(width);
              }
            }
          },
          onAutoResizeImagesChange: (enabled) => {
            this.settingsManager.setImageAutoResize(enabled);
          },
          onBlockImagesChange: (blocked) => {
            this.settingsManager.setBlockImages(blocked);
          },
          onEnableSkillCommandsChange: (enabled) => {
            this.settingsManager.setEnableSkillCommands(enabled);
            this.setupAutocomplete(this.fdPath);
          },
          onBuiltinSkillChange: (id, enabled) => {
            this.settingsManager.setBuiltinSkillEnabled(id, enabled);
            this.resourceLoaderValue.reloadSkills?.();
            this.setupAutocomplete(this.fdPath);
          },
          onTransportChange: (transport) => {
            this.settingsManager.setTransport(transport);
            // transport not applicable in facade mode
          },
          onThinkingLevelChange: (level) => {
            this.setThinkingLevelFacade(level);
            this.footer.invalidate();
            this.updateEditorBorderColor();
          },
          onThemeChange: (themeName) => {
            const result = setTheme(themeName, true);
            this.settingsManager.setTheme(themeName);
            this.updateTerminalTitle();
            this.ui.invalidate();
            if (!result.success) {
              this.showError(
                `Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`,
              );
            }
          },
          onThemePreview: (themeName) => {
            const result = setTheme(themeName, true);
            if (result.success) {
              this.ui.invalidate();
              this.ui.requestRender();
            }
          },
          onHideThinkingBlockChange: (hidden) => {
            this.hideThinkingBlock = hidden;
            this.settingsManager.setHideThinkingBlock(hidden);
            for (const child of this.chatContainer.children) {
              if (child instanceof AssistantMessageComponent) {
                child.setHideThinkingBlock(hidden);
              }
            }
            this.chatContainer.clear();
            this.rebuildChatFromMessages();
          },
          onCollapseChangelogChange: (collapsed) => {
            this.settingsManager.setCollapseChangelog(collapsed);
          },
          onEnableInstallTelemetryChange: (enabled) => {
            this.settingsManager.setEnableInstallTelemetry(enabled);
          },
          onQuietStartupChange: (enabled) => {
            this.settingsManager.setQuietStartup(enabled);
          },
          onDoubleEscapeActionChange: (action) => {
            this.settingsManager.setDoubleEscapeAction(action);
          },
          onTreeFilterModeChange: (mode) => {
            this.settingsManager.setTreeFilterMode(mode);
          },
          onShowHardwareCursorChange: (enabled) => {
            this.settingsManager.setShowHardwareCursor(enabled);
            this.ui.setShowHardwareCursor(enabled);
          },
          onEditorPaddingXChange: (padding) => {
            this.settingsManager.setEditorPaddingX(padding);
            this.defaultEditor.setPaddingX(padding);
            if (
              this.editor !== this.defaultEditor &&
              this.editor.setPaddingX !== undefined
            ) {
              this.editor.setPaddingX(padding);
            }
          },
          onAutocompleteMaxVisibleChange: (maxVisible) => {
            this.settingsManager.setAutocompleteMaxVisible(maxVisible);
            this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
            if (
              this.editor !== this.defaultEditor &&
              this.editor.setAutocompleteMaxVisible !== undefined
            ) {
              this.editor.setAutocompleteMaxVisible(maxVisible);
            }
          },
          onClearOnShrinkChange: (enabled) => {
            this.settingsManager.setClearOnShrink(enabled);
            this.ui.setClearOnShrink(enabled);
          },
          onSafeModeChange: (enabled) => {
            this.settingsManager.setSafeMode(enabled);
            this.facade.runtime.setSafeMode(enabled);
            this.showStatus(
              enabled
                ? "Safe mode on — risky tools require approval"
                : "Safe mode off — tools auto-run",
            );
          },
          onCancel: () => {
            done();
            this.ui.requestRender();
          },
        },
      );
      return { component: selector, focus: selector.getSettingsList() };
    });
  }

  private async handleModelCommand(searchTerm?: string): Promise<void> {
    if (!searchTerm) {
      this.showModelSelector();
      return;
    }

    const model = await this.findExactModelMatch(searchTerm);
    if (model) {
      try {
        await this.setModelFacade(model);
        this.footer.invalidate();
        this.updateEditorBorderColor();
        this.showStatus(`Model: ${model.id}`);
        void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
        this.checkDaxnutsEasterEgg(model);
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    this.showModelSelector(searchTerm);
  }

  private async findExactModelMatch(
    searchTerm: string,
  ): Promise<Model<any> | undefined> {
    const models = await this.getModelCandidates();
    return findExactModelReferenceMatch(searchTerm, models);
  }

  private async getModelCandidates(): Promise<Model<any>[]> {
    this.modelRegistryValue.refresh();
    try {
      return await this.modelRegistryValue.getAvailable();
    } catch {
      return [];
    }
  }

  /** Update the footer's available provider count from current model candidates */
  private async updateAvailableProviderCount(): Promise<void> {
    const models = await this.getModelCandidates();
    const uniqueProviders = new Set(models.map((m) => m.provider));
    this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
  }

  private async maybeWarnAboutAnthropicSubscriptionAuth(
    model: Model<any> | undefined = this.currentModel,
  ): Promise<void> {
    if (this.anthropicSubscriptionWarningShown) {
      return;
    }
    if (!model || model.provider !== "anthropic") {
      return;
    }

    const storedCredential =
      this.modelRegistryValue.authStorage.get("anthropic");
    if (storedCredential?.type === "oauth") {
      this.anthropicSubscriptionWarningShown = true;
      this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
      return;
    }

    try {
      const apiKey = await this.modelRegistryValue.getApiKeyForProvider(
        model.provider,
      );
      if (!isAnthropicSubscriptionAuthKey(apiKey)) {
        return;
      }
      this.anthropicSubscriptionWarningShown = true;
      this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
    } catch {
      // Ignore auth lookup failures for warning-only checks.
    }
  }

  private showModelSelector(initialSearchInput?: string): void {
    this.showSelector((done) => {
      const selector = new ModelSelectorComponent(
        this.ui,
        this.currentModel,
        this.settingsManager,
        this.modelRegistryValue,
        async (model) => {
          try {
            await this.setModelFacade(model);
            this.footer.invalidate();
            this.updateEditorBorderColor();
            done();
            this.showStatus(`Model: ${model.id}`);
            void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
            this.checkDaxnutsEasterEgg(model);
          } catch (error) {
            done();
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        initialSearchInput,
      );
      return { component: selector, focus: selector };
    });
  }

  private showRewindSelector(): void {
    const userMessages = this.getUserMessagesForForkingFacade();

    if (userMessages.length === 0) {
      this.showStatus("No messages to rewind from");
      return;
    }

    const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

    this.showSelector((done) => {
      const selector = new UserMessageSelectorComponent(
        userMessages.map((m) => ({ id: m.entryId, text: m.text })),
        async (entryId) => {
          try {
            await this.waitForTurnIdleBeforeSessionChange();
            this.facade.runtime.fork(entryId);
            this.renderCurrentSessionState();
            this.editor.setText("");
            done();
            this.showStatus("Rewound to new branch");
          } catch (error: unknown) {
            done();
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        initialSelectedId,
      );
      return { component: selector, focus: selector.getMessageList() };
    });
  }

  private showTreeSelector(initialSelectedId?: string): void {
    const timeline = this.facade.getProjection().getTimeline();
    const realLeafId = this.facade.runtime.store?.head ?? null;
    const initialFilterMode = this.settingsManager.getTreeFilterMode();

    // Convert timeline entries to SessionTreeNode[] for TreeSelectorComponent
    // In the event-sourced model there is no intra-session branching, so this is a flat list
    const tree: SessionTreeNode[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i]!;
      tree.push({
        entry: {
          type: entry.kind,
          id: entry.event_id,
          parentId: i > 0 ? timeline[i - 1]!.event_id : null,
          timestamp: new Date(entry.timestamp).toISOString(),
        } as any as SessionEntry,
        children: [],
      });
    }

    if (tree.length === 0) {
      this.showStatus("No entries in session");
      return;
    }

    this.showSelector((done) => {
      const selector = new TreeSelectorComponent(
        tree,
        realLeafId,
        this.ui.terminal.rows,
        async (entryId) => {
          // Selecting the current leaf is a no-op (already there)
          if (entryId === realLeafId) {
            done();
            this.showStatus("Already at this point");
            return;
          }

          // Ask about summarization
          done(); // Close selector first

          // Loop until user makes a complete choice or cancels to tree
          let wantsSummary = false;
          let customInstructions: string | undefined;

          // Check if we should skip the prompt (user preference to always default to no summary)
          if (!this.settingsManager.getBranchSummarySkipPrompt()) {
            while (true) {
              const summaryChoice = await this.showExtensionSelector(
                "Summarize branch?",
                ["No summary", "Summarize", "Summarize with custom prompt"],
              );

              if (summaryChoice === undefined) {
                // User pressed escape - re-show tree selector with same selection
                this.showTreeSelector(entryId);
                return;
              }

              wantsSummary = summaryChoice !== "No summary";

              if (summaryChoice === "Summarize with custom prompt") {
                customInstructions = await this.showExtensionEditor(
                  "Custom summarization instructions",
                );
                if (customInstructions === undefined) {
                  // User cancelled - loop back to summary selector
                  continue;
                }
              }

              // User made a complete choice
              break;
            }
          }

          // Set up escape handler and loader if summarizing
          let summaryLoader: Loader | undefined;
          const originalOnEscape = this.defaultEditor.onEscape;

          if (wantsSummary) {
            this.defaultEditor.onEscape = () => {
              this.abortBranchSummaryFacade();
            };
            this.chatContainer.addChild(new Spacer(1));
            summaryLoader = new Loader(
              this.ui,
              (spinner) => theme.fg("accent", spinner),
              (text) => theme.fg("muted", text),
              `Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
            );
            this.statusContainer.addChild(summaryLoader);
            this.ui.requestRender();
          }

          try {
            const result = await this.navigateTreeFacade(entryId, {
              summarize: wantsSummary,
              customInstructions,
            });

            if (result.aborted) {
              // Summarization aborted - re-show tree selector with same selection
              this.showStatus("Branch summarization cancelled");
              this.showTreeSelector(entryId);
              return;
            }
            if (result.cancelled) {
              this.showStatus("Navigation cancelled");
              return;
            }

            // Update UI
            this.chatContainer.clear();
            this.renderInitialMessages();
            if (result.editorText && !this.editor.getText().trim()) {
              this.editor.setText(result.editorText);
            }
            this.showStatus("Navigated to selected point");
            void this.flushCompactionQueue({ willRetry: false });
          } catch (error) {
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            if (summaryLoader) {
              summaryLoader.stop();
              this.statusContainer.clear();
            }
            this.defaultEditor.onEscape = originalOnEscape;
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        (_entryId, _label) => {
          // Labels are not supported in event-sourced model; no-op
        },
        initialSelectedId,
        initialFilterMode,
      );
      return { component: selector, focus: selector };
    });
  }

  /**
   * Session-structure actions (fork / rewind / navigate / resume) place their
   * boundary at the store head. While a turn is streaming, the head sits
   * inside the streaming answer and the boundary would steal the rest of the
   * answer from the session where the user asked (attribution bug). Wait for
   * the prompt cycle to settle first; surface a status so the wait is visible.
   */
  private async waitForTurnIdleBeforeSessionChange(): Promise<void> {
    if (this.facade?.isRunning) {
      this.showStatus("Finishing current turn before switching session...");
      await this.facade.waitForIdle();
    }
  }

  private async handleResumeSession(
    sessionPath: string,
    options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
  ): Promise<{ cancelled: boolean }> {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();
    try {
      await this.waitForTurnIdleBeforeSessionChange();
      this.facade.runtime.switchSession(sessionPath);
      this.renderCurrentSessionState();
      this.showStatus("Resumed session");
      return { cancelled: false };
    } catch (error: unknown) {
      if (error instanceof MissingSessionCwdError) {
        const selectedCwd = await this.promptForMissingSessionCwd(error);
        if (!selectedCwd) {
          this.showStatus("Resume cancelled");
          return { cancelled: true };
        }
        await this.waitForTurnIdleBeforeSessionChange();
        this.facade.runtime.switchSession(sessionPath);
        this.renderCurrentSessionState();
        this.showStatus("Resumed session in current cwd");
        return { cancelled: false };
      }
      return this.handleFatalRuntimeError("Failed to resume session", error);
    }
  }

  private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
    if (mode === "logout") {
      const stored = this.modelRegistryValue.authStorage
        .list()
        .filter((id) => this.modelRegistryValue.authStorage.get(id) !== undefined);
      if (stored.length === 0) {
        this.showStatus("No accounts signed in. Use /login first.");
        return;
      }
    }

    this.showSelector((done) => {
      const selector = new OAuthSelectorComponent(
        mode,
        this.modelRegistryValue.authStorage,
        async (providerId: string, kind: "account" | "apiKey") => {
          done();

          if (mode === "login") {
            if (kind === "apiKey") {
              await this.showApiKeyLoginDialog(providerId);
            } else {
              await this.showLoginDialog(providerId);
            }
          } else {
            // Logout flow
            const providerName =
              this.displayNameForAuth(providerId, kind) || providerId;

            try {
              this.modelRegistryValue.authStorage.logout(providerId);
              this.modelRegistryValue.refresh();
              await this.updateAvailableProviderCount();
              this.showStatus(`Logged out of ${providerName}`);
            } catch (error: unknown) {
              this.showError(
                `Logout failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
      );
      return { component: selector, focus: selector };
    });
  }

  /** Resolve a display name for either auth category. */
  private displayNameForAuth(providerId: string, kind: "account" | "apiKey"): string {
    const flows = this.modelRegistryValue.authStorage.getOAuthFlows();
    if (kind === "account") {
      return flows.find((f) => f.id === providerId)?.name ?? providerId;
    }
    return getApiKeyOptions().find((o) => o.id === providerId)?.name ?? providerId;
  }

  /** "Sign in with an API key": prompt for the key and store it. */
  private async showApiKeyLoginDialog(providerId: string): Promise<void> {
    const providerName = this.displayNameForAuth(providerId, "apiKey");
    const dialog = new LoginDialogComponent(this.ui, providerId, () => {}, "apiKey");

    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();

    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    try {
      await this.modelRegistryValue.authStorage.loginApiKey(providerId, {
        signal: dialog.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            throw new Error("Unexpected selection prompt during API key login");
          }
          if (prompt.type === "manual_code") {
            return dialog.showManualInput("Paste API key:").then((v) => v ?? "");
          }
          // pi-ai API-key login issues text/secret prompts
          return dialog.showPrompt(
            prompt.message || `Enter ${providerName}`,
            prompt.placeholder,
          );
        },
        notify: (event) => {
          if (event.type === "info" || event.type === "progress") {
            dialog.showProgress(event.message);
          }
        },
      });

      restoreEditor();
      this.modelRegistryValue.refresh();
      await this.updateAvailableProviderCount();
      this.showStatus(`API key saved for ${providerName}`);
    } catch (error) {
      restoreEditor();
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`API key login failed: ${message}`);
    }
  }

  private async showLoginDialog(providerId: string): Promise<void> {
    const flow = this.modelRegistryValue.authStorage
      .getOAuthFlows()
      .find((f) => f.id === providerId);
    const providerName = flow?.name || providerId;
    const previousModel = this.currentModel;

    // Providers that use callback servers (can paste redirect URL)
    const usesCallbackServer = flow?.usesCallbackServer ?? false;

    // Create login dialog component
    const dialog = new LoginDialogComponent(
      this.ui,
      providerId,
      (_success, _message) => {
        // Completion handled below
      },
    );

    // Show dialog in editor container
    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();

    // Promise for manual code input (racing with callback server)
    let manualCodeResolve: ((code: string) => void) | undefined;
    let manualCodeReject: ((err: Error) => void) | undefined;
    const manualCodePromise = new Promise<string>((resolve, reject) => {
      manualCodeResolve = resolve;
      manualCodeReject = reject;
    });

    // Restore editor helper
    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    try {
      await this.modelRegistryValue.authStorage.login(providerId, {
        signal: dialog.signal,

        // pi-ai AuthInteraction.prompt: text / secret / select / manual_code
        prompt: async (prompt) => {
          switch (prompt.type) {
            case "select": {
              const optionsText = prompt.options
                .map((o) => `${o.id}: ${o.label}`)
                .join("\n");
              const input = await dialog.showPrompt(
                `${prompt.message}\n${optionsText}`,
                prompt.options[0]?.id,
              );
              const selected = prompt.options.find(
                (o) => o.id === input || o.label === input,
              )?.id;
              if (!selected) throw new Error("Selection cancelled");
              return selected;
            }
            case "manual_code":
              return manualCodePromise;
            default:
              // "text" | "secret"
              return dialog.showPrompt(prompt.message, prompt.placeholder);
          }
        },

        // pi-ai AuthInteraction.notify: auth_url / device_code / info / progress
        notify: (event) => {
          switch (event.type) {
            case "auth_url":
              dialog.showAuth(event.url, event.instructions);

              if (usesCallbackServer) {
                // Show input for manual paste, racing with callback
                dialog
                  .showManualInput(
                    "Paste redirect URL below, or complete login in browser:",
                  )
                  .then((value) => {
                    if (value && manualCodeResolve) {
                      manualCodeResolve(value);
                      manualCodeResolve = undefined;
                    }
                  })
                  .catch(() => {
                    if (manualCodeReject) {
                      manualCodeReject(new Error("Login cancelled"));
                      manualCodeReject = undefined;
                    }
                  });
              } else if (providerId === "github-copilot") {
                // GitHub Copilot polls after auth_url
                dialog.showWaiting("Waiting for browser authentication...");
              }
              break;

            case "device_code":
              dialog.showAuth(
                event.verificationUri,
                `Enter code: ${event.userCode}`,
              );
              break;

            default:
              // "info" | "progress"
              dialog.showProgress(event.message);
              break;
          }
        },
      });

      // Success
      restoreEditor();
      this.modelRegistryValue.refresh();

      let selectedModel: Model<any> | undefined;
      let selectionError: string | undefined;
      if (isUnknownModel(previousModel)) {
        const availableModels = this.modelRegistryValue.getAvailable();
        const providerModels = availableModels.filter(
          (model) => model.provider === providerId,
        );
        if (!hasDefaultModelProvider(providerId)) {
          selectionError = `Logged in to ${providerName}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
        } else if (providerModels.length === 0) {
          selectionError = `Logged in to ${providerName}, but no models are available for that provider. Use /model to select a model.`;
        } else {
          const defaultModelId = defaultModelPerProvider[providerId];
          selectedModel = providerModels.find(
            (model) => model.id === defaultModelId,
          );
          if (!selectedModel) {
            selectionError = `Logged in to ${providerName}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
          } else {
            try {
              await this.setModelFacade(selectedModel);
            } catch (error: unknown) {
              selectedModel = undefined;
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              selectionError = `Logged in to ${providerName}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
            }
          }
        }
      }

      await this.updateAvailableProviderCount();
      this.footer.invalidate();
      this.updateEditorBorderColor();
      if (selectedModel) {
        this.showStatus(
          `Logged in to ${providerName}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`,
        );
        void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
        this.checkDaxnutsEasterEgg(selectedModel);
      } else {
        this.showStatus(
          `Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`,
        );
        if (selectionError) {
          this.showError(selectionError);
        } else {
          void this.maybeWarnAboutAnthropicSubscriptionAuth();
        }
      }
    } catch (error: unknown) {
      restoreEditor();
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg !== "Login cancelled") {
        this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
      }
    }
  }

  // =========================================================================
  // Command handlers
  // =========================================================================

  private async handleReloadCommand(): Promise<void> {
    if (this.isStreaming) {
      this.showWarning(
        "Wait for the current response to finish before reloading.",
      );
      return;
    }
    if (this.isCompacting) {
      this.showWarning("Wait for compaction to finish before reloading.");
      return;
    }

    this.resetExtensionUI();

    const reloadBox = new Container();
    const borderColor = (s: string) => theme.fg("border", s);
    reloadBox.addChild(new DynamicBorder(borderColor));
    reloadBox.addChild(new Spacer(1));
    reloadBox.addChild(
      new Text(
        theme.fg(
          "muted",
          "Reloading keybindings, extensions, skills, prompts, themes...",
        ),
        1,
        0,
      ),
    );
    reloadBox.addChild(new Spacer(1));
    reloadBox.addChild(new DynamicBorder(borderColor));

    const previousEditor = this.editor;
    this.editorContainer.clear();
    this.editorContainer.addChild(reloadBox);
    this.ui.setFocus(reloadBox);
    this.ui.requestRender(true);
    await new Promise((resolve) => process.nextTick(resolve));

    const dismissReloadBox = (editor: Component) => {
      this.editorContainer.clear();
      this.editorContainer.addChild(editor);
      this.ui.setFocus(editor);
      this.ui.requestRender();
    };

    try {
      await this.reloadFacade();
      this.keybindings.reload();
      const activeHeader = this.customHeader ?? this.builtInHeader;
      if (isExpandable(activeHeader)) {
        activeHeader.setExpanded(this.toolOutputExpanded);
      }
      setRegisteredThemes(this.resourceLoaderValue.getThemes().themes);
      this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
      const themeName = this.settingsManager.getTheme();
      const themeResult = themeName
        ? setTheme(themeName, true)
        : { success: true };
      if (!themeResult.success) {
        this.showError(
          `Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`,
        );
      }
      const editorPaddingX = this.settingsManager.getEditorPaddingX();
      const autocompleteMaxVisible =
        this.settingsManager.getAutocompleteMaxVisible();
      this.defaultEditor.setPaddingX(editorPaddingX);
      this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
      if (this.editor !== this.defaultEditor) {
        this.editor.setPaddingX?.(editorPaddingX);
        this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
      }
      this.ui.setShowHardwareCursor(
        this.settingsManager.getShowHardwareCursor(),
      );
      this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
      this.setupAutocomplete(this.fdPath);
      const runner = this.extensionRunnerValue;
      this.setupExtensionShortcuts(runner);
      this.rebuildChatFromMessages();
      dismissReloadBox(this.editor as Component);
      this.showLoadedResources({
        force: false,
        showDiagnosticsWhenQuiet: true,
      });
      const modelsJsonError = this.modelRegistryValue.getError();
      if (modelsJsonError) {
        this.showError(`models.json error: ${modelsJsonError}`);
      }
      this.showStatus(
        "Reloaded keybindings, extensions, skills, prompts, themes",
      );
    } catch (error) {
      dismissReloadBox(previousEditor as Component);
      this.showError(
        `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleExportCommand(text: string): Promise<void> {
    const outputPath = this.getPathCommandArgument(text, "/export");

    try {
      if (outputPath?.endsWith(".jsonl")) {
        this.showError("Legacy JSONL session export is no longer supported.");
      } else {
        const filePath = await this.exportToHtmlFacade(outputPath);
        this.showStatus(`Session exported to: ${filePath}`);
      }
    } catch (error: unknown) {
      this.showError(
        `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private getPathCommandArgument(
    text: string,
    command: "/export",
  ): string | undefined {
    if (text === command) {
      return undefined;
    }
    if (!text.startsWith(`${command} `)) {
      return undefined;
    }

    const argsString = text.slice(command.length + 1).trimStart();
    if (!argsString) {
      return undefined;
    }

    const firstChar = argsString[0];
    if (firstChar === '"' || firstChar === "'") {
      const closingQuoteIndex = argsString.indexOf(firstChar, 1);
      if (closingQuoteIndex < 0) {
        return undefined;
      }
      return argsString.slice(1, closingQuoteIndex);
    }

    const firstWhitespaceIndex = argsString.search(/\s/);
    if (firstWhitespaceIndex < 0) {
      return argsString;
    }
    return argsString.slice(0, firstWhitespaceIndex);
  }

  private async handleShareCommand(): Promise<void> {
    // Check if gh is available and logged in
    try {
      const authResult = spawnSync("gh", ["auth", "status"], {
        encoding: "utf-8",
      });
      if (authResult.status !== 0) {
        this.showError(
          "GitHub CLI is not logged in. Run 'gh auth login' first.",
        );
        return;
      }
    } catch {
      this.showError(
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
      );
      return;
    }

    // Export to a temp file
    const tmpFile = path.join(os.tmpdir(), "session.html");
    try {
      await this.exportToHtmlFacade(tmpFile);
    } catch (error: unknown) {
      this.showError(
        `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return;
    }

    // Show cancellable loader, replacing the editor
    const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
    this.editorContainer.clear();
    this.editorContainer.addChild(loader);
    this.ui.setFocus(loader);
    this.ui.requestRender();

    const restoreEditor = () => {
      loader.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    };

    // Create a secret gist asynchronously
    let proc: ReturnType<typeof spawn> | null = null;

    loader.onAbort = () => {
      proc?.kill();
      restoreEditor();
      this.showStatus("Share cancelled");
    };

    try {
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
      }>((resolve) => {
        proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
      });

      if (loader.signal.aborted) return;

      restoreEditor();

      if (result.code !== 0) {
        const errorMsg = result.stderr?.trim() || "Unknown error";
        this.showError(`Failed to create gist: ${errorMsg}`);
        return;
      }

      // Extract gist ID from the URL returned by gh
      // gh returns something like: https://gist.github.com/username/GIST_ID
      const gistUrl = result.stdout?.trim();
      const gistId = gistUrl?.split("/").pop();
      if (!gistId) {
        this.showError("Failed to parse gist ID from gh output");
        return;
      }

      // Create the preview URL
      const previewUrl = getShareViewerUrl(gistId);
      this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
    } catch (error: unknown) {
      if (!loader.signal.aborted) {
        restoreEditor();
        this.showError(
          `Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  }

  private async handleCopyCommand(): Promise<void> {
    const text = this.getLastAssistantTextFacade();
    if (!text) {
      this.showError("No agent messages to copy yet.");
      return;
    }

    try {
      await copyToClipboard(text);
      this.showStatus("Copied last agent message to clipboard");
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private handleStatsCommand(): void {
    const messages = this.facade.getProjection().buildContext().messages;
    const stats = computeMessageStats(messages);

    let info = `${theme.bold("Stats")}\n\n`;
    info += `${theme.bold("Messages")}\n`;
    info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
    info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
    info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
    info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
    info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
    info += `${theme.bold("Tokens")}\n`;
    info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
    info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
    if (stats.tokens.cacheRead > 0) {
      info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
    }
    if (stats.tokens.cacheWrite > 0) {
      info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
    }
    info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;
    if (stats.cost > 0) {
      info += `\n${theme.bold("Cost")}\n`;
      info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
    }
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(info, 1, 0));
    this.ui.requestRender();
  }

  /**
   * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
   */
  private capitalizeKey(key: string): string {
    return key
      .split("/")
      .map((k) =>
        k
          .split("+")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("+"),
      )
      .join("/");
  }

  /**
   * Get capitalized display string for an app keybinding action.
   */
  private getAppKeyDisplay(action: AppKeybinding): string {
    return this.capitalizeKey(keyText(action));
  }

  /**
   * Get capitalized display string for an editor keybinding action.
   */
  private getEditorKeyDisplay(action: Keybinding): string {
    return this.capitalizeKey(keyText(action));
  }

  private handleHotkeysCommand(): void {
    // Navigation keybindings
    const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
    const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
    const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
    const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
    const cursorWordLeft = this.getEditorKeyDisplay(
      "tui.editor.cursorWordLeft",
    );
    const cursorWordRight = this.getEditorKeyDisplay(
      "tui.editor.cursorWordRight",
    );
    const cursorLineStart = this.getEditorKeyDisplay(
      "tui.editor.cursorLineStart",
    );
    const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
    const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
    const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
    const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
    const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

    // Editing keybindings
    const submit = this.getEditorKeyDisplay("tui.input.submit");
    const newLine = this.getEditorKeyDisplay("tui.input.newLine");
    const deleteWordBackward = this.getEditorKeyDisplay(
      "tui.editor.deleteWordBackward",
    );
    const deleteWordForward = this.getEditorKeyDisplay(
      "tui.editor.deleteWordForward",
    );
    const deleteToLineStart = this.getEditorKeyDisplay(
      "tui.editor.deleteToLineStart",
    );
    const deleteToLineEnd = this.getEditorKeyDisplay(
      "tui.editor.deleteToLineEnd",
    );
    const yank = this.getEditorKeyDisplay("tui.editor.yank");
    const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
    const undo = this.getEditorKeyDisplay("tui.editor.undo");
    const tab = this.getEditorKeyDisplay("tui.input.tab");

    // App keybindings
    const interrupt = this.getAppKeyDisplay("app.interrupt");
    const clear = this.getAppKeyDisplay("app.clear");
    const exit = this.getAppKeyDisplay("app.exit");
    const suspend = this.getAppKeyDisplay("app.suspend");
    const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
    const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
    const selectModel = this.getAppKeyDisplay("app.model.select");
    const expandTools = this.getAppKeyDisplay("app.tools.expand");
    const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
    const externalEditor = this.getAppKeyDisplay("app.editor.external");
    const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
    const followUp = this.getAppKeyDisplay("app.message.followUp");
    const dequeue = this.getAppKeyDisplay("app.message.dequeue");
    const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

    let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

    // Add extension-registered shortcuts
    const extensionRunner = this.extensionRunnerValue;
    const shortcuts = extensionRunner.getShortcuts(
      this.keybindings.getEffectiveConfig(),
    );
    if (shortcuts.size > 0) {
      hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
      for (const [key, shortcut] of shortcuts) {
        const description = shortcut.description ?? shortcut.extensionPath;
        const keyDisplay = key.replace(/\b\w/g, (c) => c.toUpperCase());
        hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
      }
    }

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(
      new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0),
    );
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()),
    );
    this.chatContainer.addChild(new DynamicBorder());
    this.ui.requestRender();
  }

  private handleDebugCommand(): void {
    const width = this.ui.terminal.columns;
    const height = this.ui.terminal.rows;
    const allLines = this.ui.render(width);

    const debugLogPath = getDebugLogPath();
    const debugData = [
      `Debug output at ${new Date().toISOString()}`,
      `Terminal: ${width}x${height}`,
      `Total lines: ${allLines.length}`,
      "",
      "=== All rendered lines with visible widths ===",
      ...allLines.map((line, idx) => {
        const vw = visibleWidth(line);
        const escaped = JSON.stringify(line);
        return `[${idx}] (w=${vw}) ${escaped}`;
      }),
      "",
      "=== Agent messages (JSONL) ===",
      ...this.messagesValue.map((msg) => JSON.stringify(msg)),
      "",
    ].join("\n");

    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.writeFileSync(debugLogPath, debugData);

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(
        `${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`,
        1,
        1,
      ),
    );
    this.ui.requestRender();
  }

  private handleDaxnuts(): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DaxnutsComponent(this.ui));
    this.ui.requestRender();
  }

  private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
    if (
      model.provider === "opencode" &&
      model.id.toLowerCase().includes("kimi-k2.5")
    ) {
      this.handleDaxnuts();
    }
  }

  private async handleBashCommand(
    command: string,
    excludeFromContext = false,
  ): Promise<void> {
    const extensionRunner = this.extensionRunnerValue;

    // Emit user_bash event to let extensions intercept
    const eventResult = await extensionRunner.emitUserBash({
      type: "user_bash",
      command,
      excludeFromContext,
      cwd: this.facadeCwd,
    });

    // If extension returned a full result, use it directly
    if (eventResult?.result) {
      const result = eventResult.result;

      // Create UI component for display
      this.bashComponent = new BashExecutionComponent(
        command,
        this.ui,
        excludeFromContext,
      );
      if (this.isStreaming) {
        this.pendingMessagesContainer.addChild(this.bashComponent);
        this.pendingBashComponents.push(this.bashComponent);
      } else {
        this.chatContainer.addChild(this.bashComponent);
      }

      // Show output and complete
      if (result.output) {
        this.bashComponent.appendOutput(result.output);
      }
      this.bashComponent.setComplete(
        result.exitCode,
        result.cancelled,
        result.truncated
          ? ({ truncated: true, content: result.output } as TruncationResult)
          : undefined,
        result.fullOutputPath,
      );

      // Record the result in session
      this.recordBashResultFacade(command, result, { excludeFromContext });
      this.bashComponent = undefined;
      this.ui.requestRender();
      return;
    }

    // Normal execution path (possibly with custom operations)
    const isDeferred = this.isStreaming;
    this.bashComponent = new BashExecutionComponent(
      command,
      this.ui,
      excludeFromContext,
    );

    if (isDeferred) {
      // Show in pending area when agent is streaming
      this.pendingMessagesContainer.addChild(this.bashComponent);
      this.pendingBashComponents.push(this.bashComponent);
    } else {
      // Show in chat immediately when agent is idle
      this.chatContainer.addChild(this.bashComponent);
    }
    this.ui.requestRender();

    try {
      const result = await this.executeBashFacade(
        command,
        (chunk) => {
          if (this.bashComponent) {
            this.bashComponent.appendOutput(chunk);
            this.ui.requestRender();
          }
        },
        { excludeFromContext, operations: eventResult?.operations },
      );

      if (this.bashComponent) {
        this.bashComponent.setComplete(
          result.exitCode,
          result.cancelled,
          result.truncated
            ? ({ truncated: true, content: result.output } as TruncationResult)
            : undefined,
          result.fullOutputPath,
        );
      }

      // Record the result in session
      this.recordBashResultFacade(command, result, { excludeFromContext });
    } catch (error) {
      if (this.bashComponent) {
        this.bashComponent.setComplete(undefined, false);
      }
      this.showError(
        `Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }

    this.bashComponent = undefined;
    this.ui.requestRender();
  }

  private async handleCompactCommand(
    customInstructions?: string,
  ): Promise<void> {
    const entries = this.facade.getProjection().getTimeline();
    const messageCount = entries.filter(
      (e: any) => e.kind === "message",
    ).length;

    if (messageCount < 2) {
      this.showWarning("Nothing to compact (no messages yet)");
      return;
    }

    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();

    try {
      await this.compactFacade(customInstructions);
    } catch {
      // Ignore, will be emitted as an event
    }
  }

  stop(): void {
    this.unregisterSignalHandlers();
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.clearExtensionTerminalInputListeners();
    this.footer.dispose();
    this.footerDataProvider.dispose();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.taskHistoryUnsubscribe?.();
    this.taskHistoryUnsubscribe = undefined;
    this.taskHistoryProjection?.stopLive();
    this.taskHistoryProjection = undefined;
    if (this.isInitialized) {
      this.ui.stop();
      this.isInitialized = false;
    }
  }
}
