import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding } from "../../../src/core/commands/keybindings.js";
import type { TaskHistoryItem } from "../../../src/core/projection/task-history.js";
import { theme } from "../theme/theme.js";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.js";

const LOGO_LINES = [
	" ██████╗ ██╗███████╗███████╗ █████╗ ",
	" ██╔══██╗██║╚══███╔╝╚══███╔╝██╔══██╗",
	" ██████╔╝██║  ███╔╝   ███╔╝ ███████║",
	" ██╔═══╝ ██║ ███╔╝   ███╔╝  ██╔══██║",
	" ██║     ██║███████╗███████╗██║  ██║",
	" ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝",
];

export class BrandHeaderComponent implements Component {
	private expanded: boolean;
	private cachedWidth?: number;
	private cachedExpanded?: boolean;
	private cachedLines?: string[];
	private taskHistory: TaskHistoryItem[] = [];

	constructor(
		private readonly appName: string,
		private readonly version: string,
		expanded = false,
	) {
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.invalidate();
	}

	setTaskHistory(taskHistory: TaskHistoryItem[]): void {
		this.taskHistory = taskHistory.slice(0, 3);
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedExpanded = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth && this.cachedExpanded === this.expanded) {
			return this.cachedLines;
		}

		const lines =
			safeWidth >= 68
				? this.renderFull(safeWidth)
				: safeWidth >= 46
					? this.renderBoxedCompact(safeWidth)
					: this.renderTiny(safeWidth);

		this.cachedWidth = safeWidth;
		this.cachedExpanded = this.expanded;
		this.cachedLines = lines;
		return lines;
	}

	private renderFull(width: number): string[] {
		const lines = [
			this.rule(width, "╭", "─", "╮"),
			this.boxedLine(this.splitLine(this.brandText(), theme.fg("muted", "terminal coding agent"), width - 4), width),
			this.rule(width, "├", "─", "┤"),
			...this.renderLogoBody(width),
			this.boxedLine("", width),
			this.boxedLine(theme.fg("muted", `Create together with ${this.displayName()}.`), width),
			this.boxedLine(theme.fg("dim", "Read code · edit files · run commands · keep context"), width),
			this.boxedLine(this.compactShortcuts(), width),
		];

		if (this.expanded) {
			lines.push(this.rule(width, "├", "─", "┤"));
			lines.push(this.boxedLine(theme.fg("dim", "Shortcuts"), width));
			lines.push(...this.expandedShortcutLines(width));
		}

		lines.push(this.rule(width, "╰", "─", "╯"));
		return lines;
	}

	private renderLogoBody(width: number): string[] {
		if (this.taskHistory.length === 0 || width < 100) {
			return LOGO_LINES.map((line) => this.boxedLine(theme.fg("accent", line), width));
		}

		const innerWidth = Math.max(1, width - 4);
		const taskWidth = Math.min(44, Math.max(32, Math.floor(innerWidth * 0.38)));
		const separator = theme.fg("borderMuted", "│");
		const separatorWidth = 3;
		const logoWidth = Math.max(1, innerWidth - taskWidth - separatorWidth);
		const taskRows = this.taskPanelRows(taskWidth);

		return LOGO_LINES.map((line, index) => {
			const logo = this.fit(theme.fg("accent", line), logoWidth);
			const task = this.fit(taskRows[index] ?? "", taskWidth);
			return this.boxedLine(`${logo} ${separator} ${task}`, width);
		});
	}

	private taskPanelRows(width: number): string[] {
		const rows = [
			theme.bold(theme.fg("muted", "Recent tasks")),
			...this.taskHistory.map((task) => this.formatTaskLine(task, width)),
		];

		while (rows.length < LOGO_LINES.length) {
			rows.push("");
		}

		return rows;
	}

	private formatTaskLine(task: TaskHistoryItem, width: number): string {
		const label = this.taskStatusLabel(task.status);
		const summaryWidth = Math.max(1, width - visibleWidth(label) - 1);
		const summary = truncateToWidth(task.summary, summaryWidth, "", true);
		return `${label} ${summary}`;
	}

	private taskStatusLabel(status: TaskHistoryItem["status"]): string {
		switch (status) {
			case "accepted":
			case "completed":
				return theme.fg("success", "done");
			case "started":
			case "in_progress":
				return theme.fg("accent", "run ");
			case "failed":
				return theme.fg("error", "fail");
			case "rework":
				return theme.fg("warning", "redo");
			case "cancelled":
				return theme.fg("muted", "stop");
			case "assigned":
				return theme.fg("muted", "asgn");
			case "created":
				return theme.fg("muted", "todo");
		}
	}

	private renderBoxedCompact(width: number): string[] {
		const lines = [
			this.rule(width, "╭", "─", "╮"),
			this.boxedLine(this.brandText(), width),
			this.boxedLine(theme.fg("muted", "Terminal coding agent"), width),
			this.boxedLine(theme.fg("dim", "Read code · edit files · run commands"), width),
			this.boxedLine(this.compactShortcuts(), width),
		];

		if (this.expanded) {
			lines.push(this.rule(width, "├", "─", "┤"));
			lines.push(...this.expandedShortcutLines(width));
		}

		lines.push(this.rule(width, "╰", "─", "╯"));
		return lines;
	}

	private renderTiny(width: number): string[] {
		const lines = [
			this.fit(this.brandText(), width),
			this.fit(theme.fg("muted", "Terminal coding agent"), width),
			this.fit(this.compactShortcuts(), width),
		];

		if (this.expanded) {
			lines.push(...this.shortcutHints().map((line) => this.fit(line, width)));
		}

		return lines;
	}

	private expandedShortcutLines(width: number): string[] {
		const hints = this.shortcutHints();
		const innerWidth = Math.max(1, width - 4);

		if (innerWidth >= 62) {
			const columnWidth = Math.floor((innerWidth - 3) / 2);
			const rows: string[] = [];
			for (let i = 0; i < hints.length; i += 2) {
				const left = this.fit(hints[i] ?? "", columnWidth);
				const right = this.fit(hints[i + 1] ?? "", columnWidth);
				rows.push(this.boxedLine(`${left} ${theme.fg("borderMuted", "│")} ${right}`, width));
			}
			return rows;
		}

		return hints.map((line) => this.boxedLine(line, width));
	}

	private shortcutHints(): string[] {
		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

		return [
			hint("app.interrupt", "to interrupt"),
			hint("app.clear", "to clear"),
			rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
			hint("app.exit", "to exit (empty)"),
			hint("app.suspend", "to suspend"),
			keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
			hint("app.thinking.cycle", "to cycle thinking level"),
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
			hint("app.model.select", "to select model"),
			hint("app.tools.expand", "to expand tools"),
			hint("app.thinking.toggle", "to expand thinking"),
			hint("app.editor.external", "for external editor"),
			rawKeyHint("/", "for commands"),
			rawKeyHint("!", "to run bash"),
			rawKeyHint("!!", "to run bash (no context)"),
			hint("app.message.followUp", "to queue follow-up"),
			hint("app.message.dequeue", "to edit all queued messages"),
			hint("app.clipboard.pasteImage", "to paste image"),
			rawKeyHint("drop files", "to attach"),
		];
	}

	private compactShortcuts(): string {
		return [
			theme.fg("dim", "/help"),
			theme.fg("muted", "commands"),
			theme.fg("dim", keyText("app.model.cycleForward")),
			theme.fg("muted", "model"),
			theme.fg("dim", keyText("app.thinking.cycle")),
			theme.fg("muted", "think"),
			theme.fg("dim", keyText("app.interrupt")),
			theme.fg("muted", "stop"),
		].join("  ");
	}

	private brandText(): string {
		return `${theme.bold(theme.fg("accent", this.brandLabel()))}${theme.fg("dim", ` v${this.version}`)}`;
	}

	private brandLabel(): string {
		return (this.appName.trim() || "pizza").toUpperCase();
	}

	private displayName(): string {
		const normalized = this.appName.trim() || "pizza";
		return normalized.charAt(0).toUpperCase() + normalized.slice(1);
	}

	private splitLine(left: string, right: string, width: number): string {
		const safeWidth = Math.max(1, width);
		const maxRightWidth = Math.max(0, safeWidth - visibleWidth(left) - 1);
		const fittedRight = maxRightWidth > 0 ? truncateToWidth(right, maxRightWidth, "") : "";
		const maxLeftWidth = Math.max(1, safeWidth - visibleWidth(fittedRight) - (fittedRight ? 1 : 0));
		const fittedLeft = truncateToWidth(left, maxLeftWidth, "");
		const gap = Math.max(1, safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
		return fittedRight ? `${fittedLeft}${" ".repeat(gap)}${fittedRight}` : this.fit(fittedLeft, safeWidth);
	}

	private boxedLine(content: string, width: number): string {
		if (width < 4) {
			return this.fit(content, width);
		}

		const border = (text: string) => theme.fg("border", text);
		const inner = this.fit(content, width - 4);
		return `${border("│")} ${inner} ${border("│")}`;
	}

	private rule(width: number, left: string, fill: string, right: string): string {
		if (width <= 1) {
			return theme.fg("border", fill.slice(0, 1));
		}

		return theme.fg("border", `${left}${fill.repeat(Math.max(0, width - 2))}${right}`);
	}

	private fit(text: string, width: number): string {
		if (width <= 0) return "";
		return truncateToWidth(text, width, "", true);
	}
}
