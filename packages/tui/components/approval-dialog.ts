import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { IntentClassification } from "../../../src/core/intent/types.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

/**
 * Approval dialog shown when the agent proposes a tool call that requires
 * user approval. The user can approve or reject with keyboard navigation.
 */
export class ApprovalDialogComponent extends Container {
	private selectedIndex = 0;
	private readonly options: string[];
	private listContainer: Container;
	private onApproveCallback: () => void;
	private onApproveAlwaysCallback: (() => void) | undefined;
	private onRejectCallback: () => void;
	private disposed = false;

	constructor(
		private readonly ui: TUI,
		private readonly classification: IntentClassification,
		private readonly toolName: string,
		private readonly args: Record<string, unknown>,
		onApprove: () => void,
		onReject: () => void,
		onApproveAlways?: () => void,
	) {
		super();

		this.onApproveCallback = onApprove;
		this.onRejectCallback = onReject;
		this.onApproveAlwaysCallback = onApproveAlways;
		// "Always allow" is only offered for moderate risk — dangerous
		// actions (file_delete, shell_dangerous) are gated unconditionally
		// by the classifier, so a session-scoped bypass must not exist.
		this.options =
			onApproveAlways && classification.risk !== "dangerous"
				? ["Approve", "Always allow (this session)", "Reject"]
				: ["Approve", "Reject"];

		this.addChild(new DynamicBorder((str: string) => theme.fg("warning", str)));
		this.addChild(new Spacer(1));

		// Title
		this.addChild(new Text(theme.bold(theme.fg("warning", "Action requires approval")), 1, 0));
		this.addChild(new Spacer(1));

		// Risk / category
		const risk = this.classification.risk;
		const riskColor = risk === "dangerous" ? "error" : risk === "moderate" ? "warning" : "text";
		this.addChild(
			new Text(
				theme.fg("text", `Risk: `) + theme.fg(riskColor, `${risk} (${this.classification.category})`),
				1,
				0,
			),
		);

		// Description
		if (this.classification.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", this.classification.description), 1, 0));
		}

		// Affected files
		if (this.classification.affected_files && this.classification.affected_files.length > 0) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", "Affected files:"), 1, 0));
			for (const file of this.classification.affected_files) {
				this.addChild(new Text(theme.fg("dim", `  ${file}`), 1, 0));
			}
		}

		// Tool name and arguments
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("text", `Tool: ${toolName}`), 1, 0));
		const argsText = this.formatArgs(args);
		if (argsText) {
			for (const line of argsText.split("\n").slice(0, 20)) {
				this.addChild(new Text(theme.fg("dim", `  ${line}`), 1, 0));
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((str: string) => theme.fg("warning", str)));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((str: string) => theme.fg("warning", str)));

		this.updateList();
	}

	private formatArgs(args: Record<string, unknown>): string {
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return String(args);
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const label = this.options[i]!;
			const color = label === "Reject" ? "error" : "accent";
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg(color, theme.bold(label))
				: `  ${theme.fg(color, label)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
		this.ui.requestRender();
	}

	handleInput(keyData: string): void {
		if (this.disposed) return;

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.choose();
		} else if (keyData === "y" || keyData === "Y") {
			this.selectedIndex = 0;
			this.choose();
		} else if (keyData === "a" || keyData === "A") {
			const alwaysIndex = this.options.findIndex((o) => o.startsWith("Always"));
			if (alwaysIndex >= 0) {
				this.selectedIndex = alwaysIndex;
				this.choose();
			}
		} else if (keyData === "n" || keyData === "N") {
			// Reject is always the last option regardless of list size.
			this.selectedIndex = this.options.length - 1;
			this.choose();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.reject();
		}
	}

	private choose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const choice = this.options[this.selectedIndex];
		if (choice === "Approve") {
			this.onApproveCallback();
		} else if (choice === "Always allow (this session)") {
			this.onApproveAlwaysCallback?.();
		} else {
			this.onRejectCallback();
		}
	}

	private reject(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onRejectCallback();
	}

	dispose(): void {
		this.disposed = true;
	}
}
