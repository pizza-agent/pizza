/**
 * Declarative list page for extensions: a SelectList with an optional
 * per-item preview pane and custom key actions.
 *
 * Exposed to extensions as `ctx.ui.page(title, options)`.
 */

import { Container, SelectList, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { theme, getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import type {
	ExtensionPageAction,
	ExtensionPageItem,
	ExtensionPageOptions,
	ExtensionPageResult,
} from "../../../src/core/extensions/types.js";

const MAX_PREVIEW_LINES = 12;

type LiveComponent = Component & { dispose?(): void };

export class ExtensionPageComponent extends Container {
	private items: ExtensionPageItem[];
	private actions: ExtensionPageAction[];
	private selectList: SelectList;
	private previewContainer: Container | undefined;
	private previewComponent: LiveComponent | undefined;
	private done: (result: ExtensionPageResult) => void;
	private ui: TUI;
	private finished = false;

	constructor(
		title: string,
		options: ExtensionPageOptions,
		done: (result: ExtensionPageResult) => void,
		ui: TUI,
	) {
		super();
		this.items = options.items;
		this.actions = options.actions ?? [];
		this.done = done;
		this.ui = ui;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			this.items.map((item) => ({ value: item.id, label: item.label, description: item.description })),
			Math.min(Math.max(this.items.length, 3), 8),
			getSelectListTheme(),
			{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
		);

		if (options.initialSelection) {
			const idx = this.items.findIndex((item) => item.id === options.initialSelection);
			if (idx !== -1) this.selectList.setSelectedIndex(idx);
		}

		this.selectList.onSelect = (item) => {
			const pageItem = this.items.find((i) => i.id === item.value);
			if (pageItem) this.finish({ kind: "select", item: pageItem });
		};
		this.selectList.onCancel = () => this.finish({ kind: "cancel" });
		this.selectList.onSelectionChange = () => this.refreshPreview();

		this.addChild(this.selectList);

		if (this.items.some((item) => item.preview)) {
			this.addChild(new Spacer(1));
			this.previewContainer = new Container();
			this.addChild(this.previewContainer);
			this.refreshPreview();
		}

		this.addChild(new Spacer(1));
		const hints = [
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "select"),
			...this.actions.map((a) => rawKeyHint(a.key, a.label)),
			keyHint("tui.select.cancel", "cancel"),
		];
		this.addChild(new Text(hints.join("  "), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private currentItem(): ExtensionPageItem | undefined {
		const selected = this.selectList.getSelectedItem();
		return selected ? this.items.find((i) => i.id === selected.value) : undefined;
	}

	private refreshPreview(): void {
		if (!this.previewContainer) return;
		this.previewComponent?.dispose?.();
		this.previewComponent = undefined;
		this.previewContainer.clear();

		const item = this.currentItem();
		const preview = item?.preview;
		if (!preview) return;

		if (Array.isArray(preview)) {
			for (const line of preview.slice(0, MAX_PREVIEW_LINES)) {
				this.previewContainer.addChild(new Text(line, 1, 0));
			}
			if (preview.length > MAX_PREVIEW_LINES) {
				this.previewContainer.addChild(new Text(theme.fg("muted", "…"), 1, 0));
			}
		} else {
			try {
				const component = preview(this.ui, theme);
				this.previewComponent = component;
				this.previewContainer.addChild(component);
			} catch {
				this.previewContainer.addChild(new Text(theme.fg("error", "(preview failed)"), 1, 0));
			}
		}
		this.ui.requestRender();
	}

	private finish(result: ExtensionPageResult): void {
		if (this.finished) return;
		this.finished = true;
		this.done(result);
	}

	handleInput(keyData: string): void {
		// Custom actions take precedence over list key handling.
		const action = this.actions.find((a) => a.key === keyData);
		if (action) {
			this.finish({ kind: "action", action: action.key, item: this.currentItem() });
			return;
		}
		this.selectList.handleInput(keyData);
	}

	dispose(): void {
		this.previewComponent?.dispose?.();
		this.previewComponent = undefined;
	}
}