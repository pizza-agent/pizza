import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage } from "../../../src/core/extensions/index.js";
import type { ReadonlyFooterDataProvider } from "../../../src/core/context/footer-data-provider.js";
import { theme } from "../theme/theme.js";
import type { ThemeColor } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

interface FooterSegment {
	text: string;
	color: ThemeColor;
}

function renderSegments(segments: FooterSegment[]): string {
	return segments.map((segment) => theme.fg(segment.color, segment.text)).join("");
}

function renderRightSide(text: string, provider?: string): string {
	if (!text) return "";
	const providerPrefix = provider ? `(${provider}) ` : undefined;
	if (providerPrefix && text.startsWith(providerPrefix)) {
		return theme.fg("dim", providerPrefix) + renderRightSide(text.slice(providerPrefix.length));
	}

	const separator = " • ";
	const separatorIndex = text.indexOf(separator);
	if (separatorIndex === -1) {
		return theme.fg("accent", text);
	}

	return (
		theme.fg("accent", text.slice(0, separatorIndex)) +
		theme.fg("dim", separator) +
		theme.fg("muted", text.slice(separatorIndex + separator.length))
	);
}

/**
 * Minimal interface for footer data access.
 * Supported by SessionFacade-based adapters.
 */
export interface FooterSessionInfo {
	/** Model info: id, provider, reasoning, contextWindow */
	getModel(): { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
	/** Current thinking level */
	getThinkingLevel(): string | undefined;
	/** Cumulative token usage from all assistant messages */
	getTokenUsage(): {
		totalInput: number;
		totalOutput: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalCost: number;
	};
	/** Context window usage */
	getContextUsage(): ContextUsage | undefined;
	/** Working directory */
	getCwd(): string;
	/** Whether the current model uses OAuth subscription */
	isUsingOAuthSubscription(): boolean;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	constructor(
		private session: FooterSessionInfo,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setSession(session: FooterSessionInfo): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		// Extract session info
		const modelInfo = this.session.getModel();
		const thinkingLevel = this.session.getThinkingLevel();
		const tokenUsage = this.session.getTokenUsage();
		const contextUsage = this.session.getContextUsage();
		const pwd = this.session.getCwd();
		const usingSubscription = this.session.isUsingOAuthSubscription();

		// Cyber-style prefix and content width (prefix takes 2 columns)
		const prefix = theme.fg("accent", "❯ ");
		const contentWidth = Math.max(1, width - 2);

		const contextWindow = contextUsage?.contextWindow ?? modelInfo?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let displayPwd = pwd;
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && displayPwd.startsWith(home)) {
			displayPwd = `~${displayPwd.slice(home.length)}`;
		}

		const pathSegments: FooterSegment[] = [{ text: displayPwd, color: "muted" }];

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			displayPwd = `${displayPwd} (${branch})`;
			pathSegments.push({ text: " (", color: "dim" });
			pathSegments.push({ text: branch, color: "accent" });
			pathSegments.push({ text: ")", color: "dim" });
		}

		// Build stats line
		const statsParts: FooterSegment[] = [];
		if (tokenUsage.totalInput) statsParts.push({ text: `↑${formatTokens(tokenUsage.totalInput)}`, color: "accent" });
		if (tokenUsage.totalOutput) statsParts.push({ text: `↓${formatTokens(tokenUsage.totalOutput)}`, color: "mdLink" });
		if (tokenUsage.totalCacheRead) statsParts.push({ text: `R${formatTokens(tokenUsage.totalCacheRead)}`, color: "muted" });
		if (tokenUsage.totalCacheWrite) statsParts.push({ text: `W${formatTokens(tokenUsage.totalCacheWrite)}`, color: "muted" });

		// Show cost with "(sub)" indicator if using OAuth subscription
		if (tokenUsage.totalCost || usingSubscription) {
			const costStr = `$${tokenUsage.totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push({ text: costStr, color: "success" });
		}

		// Colorize context percentage based on usage
		let contextColor: ThemeColor;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextColor = "error";
		} else if (contextPercentValue > 70) {
			contextColor = "warning";
		} else {
			contextColor = "success";
		}
		statsParts.push({ text: contextPercentDisplay, color: contextColor });

		let statsLeft = statsParts.map((part) => part.text).join("│");
		// Add model name on the right side, plus thinking level if model supports it
		const modelName = modelInfo?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > contentWidth) {
			statsLeft = truncateToWidth(statsLeft, contentWidth, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (modelInfo?.reasoning) {
			const level = thinkingLevel || "off";
			rightSideWithoutProvider =
				level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && modelInfo) {
			rightSide = `(${modelInfo.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > contentWidth) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let renderedStatsLeft: string;
		if (visibleWidth(statsLeft) === statsParts.reduce((sum, part) => sum + visibleWidth(part.text), 0) + Math.max(0, statsParts.length - 1)) {
			renderedStatsLeft = statsParts.map((part) => theme.fg(part.color, part.text)).join(theme.fg("borderMuted", "│"));
		} else {
			renderedStatsLeft = theme.fg("dim", statsLeft);
		}

		let statsLine: string;
		if (totalNeeded <= contentWidth) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(contentWidth - statsLeftWidth - rightSideWidth);
			statsLine = renderedStatsLeft + theme.fg("dim", padding) + renderRightSide(rightSide, modelInfo?.provider);
		} else {
			// Need to truncate right side
			const availableForRight = contentWidth - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, contentWidth - statsLeftWidth - truncatedRightWidth));
				statsLine = renderedStatsLeft + theme.fg("dim", padding) + renderRightSide(truncatedRight, modelInfo?.provider);
			} else {
				// Not enough space for right side at all
				statsLine = renderedStatsLeft;
			}
		}

		const pwdContent = truncateToWidth(renderSegments(pathSegments), contentWidth, theme.fg("dim", "..."));
		const lines = [prefix + pwdContent, prefix + statsLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(prefix + truncateToWidth(theme.fg("muted", statusLine), contentWidth, theme.fg("dim", "...")));
		}

		return lines;
	}

}
