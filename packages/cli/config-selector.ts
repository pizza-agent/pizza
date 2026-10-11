/**
 * TUI config selector for `pizza config` command
 */

import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { ResolvedPaths } from "../../src/core/skills/package-manager.js";
import type { SettingsManager } from "../../src/core/config/settings-manager.js";
import { ConfigSelectorComponent } from "../tui/components/config-selector.js";
import { initTheme, stopThemeWatcher } from "../tui/theme/theme.js";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
