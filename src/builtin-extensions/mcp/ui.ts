import {
	type Component,
	Container,
	type Focusable,
	hyperlink,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../packages/tui/components/dynamic-border.js";
import { keyHint, rawKeyHint } from "../../../packages/tui/components/keybinding-hints.js";
import { getSelectListTheme, type Theme } from "../../../packages/tui/theme/theme.js";
import type { KeybindingsManager } from "../../core/commands/keybindings.js";
import type { ExtensionCommandContext } from "../../core/extensions/types.js";
import { copyToClipboard } from "../../utils/clipboard.js";

class AuthUrlComponent extends Container {
	readonly url: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly hint: Text;

	constructor(tui: TUI, theme: Theme, url: string) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.url = url;
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		this.hint = new Text("", 1, 0);
		this.addChild(this.hint);
		this.setHint(rawKeyHint("ctrl+y", "to copy"));
	}

	private setHint(suffix: string): void {
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.hint.setText(`${this.theme.fg("dim", hyperlink(clickHint, this.url))} ${this.theme.fg("dim", "•")} ${suffix}`);
		this.tui.requestRender();
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			this.setHint(this.theme.fg("success", "Copied URL to clipboard"));
		} catch (error) {
			this.setHint(this.theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}
}

export interface McpMenu {
	title: string;
	details?: string;
	error?: string;
	items: SelectItem[];
	empty?: string;
	selected?: string;
	confirmLabel: string;
	cancelLabel: string;
}

export interface McpUi {
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined>;
	status(title: string, message: string, onCancel?: () => void): void;
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

const MAX_VISIBLE_ITEMS = 12;

export class McpManagerView implements McpUi, Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private content: Container;
	private inputHandler: ((data: string) => void) | undefined;
	private inputTarget: Focusable | undefined;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = frame(theme, "MCP servers", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	private setContent(content: Container, inputHandler?: (data: string) => void, inputTarget?: Focusable): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined> {
		return new Promise((resolve) => {
			let unsubscribe: (() => void) | undefined;
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				unsubscribe?.();
				resolve(value);
			};
			let selected: string | undefined;
			const render = () => {
				const menu = build();
				const wanted = selected ?? menu.selected;
				const body: Component[] = [];
				if (menu.details) body.push(new Text(this.theme.fg("muted", menu.details), 1, 0));
				if (menu.error) body.push(new Text(this.theme.fg("error", menu.error), 1, 0));
				body.push(new Spacer(1));
				const footer = `${keyHint("tui.select.confirm", menu.confirmLabel)} • ${keyHint("tui.select.cancel", menu.cancelLabel)}`;
				if (menu.items.length === 0) {
					body.push(new Text(this.theme.fg("muted", menu.empty ?? "Nothing to show."), 1, 0));
					this.setContent(
						frame(this.theme, menu.title, body, keyHint("tui.select.cancel", menu.cancelLabel)),
						(data) => {
							if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
						},
					);
					return;
				}
				const list = new SelectList(
					menu.items,
					Math.min(menu.items.length, MAX_VISIBLE_ITEMS),
					getSelectListTheme(),
				);
				const index = menu.items.findIndex((item) => item.value === wanted);
				if (index !== -1) list.setSelectedIndex(index);
				selected = list.getSelectedItem()?.value;
				list.onSelectionChange = (item) => {
					selected = item.value;
				};
				list.onSelect = (item) => finish(item.value);
				list.onCancel = () => finish(undefined);
				body.push(list);
				this.setContent(frame(this.theme, menu.title, body, footer), (data) => list.handleInput(data));
			};
			render();
			unsubscribe = subscribe?.(() => {
				if (!settled) render();
			});
		});
	}

	status(title: string, message: string, onCancel?: () => void): void {
		const body = [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)];
		if (!onCancel) {
			this.setContent(frame(this.theme, title, body));
			return;
		}
		this.setContent(frame(this.theme, title, body, keyHint("tui.select.cancel", "cancel")), (data) => {
			if (this.keybindings.matches(data, "tui.select.cancel")) onCancel();
		});
	}

	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			if (signal.aborted) {
				finish(undefined);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			const input = new Input();
			const link = new AuthUrlComponent(this.tui, this.theme, authorizationUrl);
			const body: Component[] = [
				new Spacer(1),
				new Text(this.theme.fg("muted", "Approve access in your browser. If it did not open, visit:"), 1, 0),
				link,
				new Spacer(1),
				new Text(
					this.theme.fg("muted", "If the browser runs on another machine, paste the URL it was redirected to:"),
					1,
					0,
				),
				input,
			];
			this.setContent(
				frame(
					this.theme,
					title,
					body,
					`${keyHint("tui.select.confirm", "submit")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				(data) => {
					if (this.keybindings.matches(data, "tui.select.confirm")) {
						const value = input.getValue().trim();
						if (value) finish(value);
						return;
					}
					if (this.keybindings.matches(data, "tui.select.cancel")) {
						finish(undefined);
						return;
					}
					if (this.keybindings.matches(data, "tui.input.copy") || data === "\x19") {
						void link.copy();
						return;
					}
					input.handleInput(data);
				},
				input,
			);
		});
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

export async function showMcpManager(
	ctx: ExtensionCommandContext,
	manage: (ui: McpUi) => Promise<void>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new McpManagerView(tui, theme, keybindings);
		void manage(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}