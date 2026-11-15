import { stripTerminalSequences, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CustomEditor } from "../packages/tui/components/custom-editor.js";
import { getEditorTheme, initTheme } from "../packages/tui/theme/theme.js";
import { KeybindingsManager } from "../src/core/commands/keybindings.js";

function createTerminal() {
	const writes: string[] = [];
	const terminal: Terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		async drainInput() {},
		write(data) { writes.push(data); },
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	return { terminal, writes };
}

describe("CustomEditor with pi-tui cursor rendering", () => {
	beforeAll(() => initTheme("dark"));

	it.each([false, true])("renders focused input without leaking cursor markers (hardware cursor: %s)", async showHardwareCursor => {
		const { terminal, writes } = createTerminal();
		const tui = new TuiMainScreen(terminal, showHardwareCursor);
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		editor.setText("hello 世界");
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			await vi.waitFor(() => expect(stripTerminalSequences(writes.join(""))).toContain("hello 世界"));
			const output = writes.join("");
			expect(output).not.toContain("\x1b_pi:");
			if (showHardwareCursor) expect(output).not.toContain("\x1b[7m");
			else expect(output).toContain("\x1b[7m");
		} finally {
			tui.stop();
		}
	});

	it("keeps the custom frame within narrow widths after wrapping Chinese input", () => {
		const { terminal } = createTerminal();
		const tui = new TuiMainScreen(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		editor.focused = true;
		editor.setText("中文输入与 Markdown **强调** mixed text");
		for (const width of [6, 12, 20, 80]) {
			const lines = editor.render(width);
			expect(stripTerminalSequences(lines[0]!)).toMatch(/┐$/);
			expect(stripTerminalSequences(lines.at(-1)!)).toMatch(/┘$/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
