import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "pizza-theme";

import { isTauri } from "./utils";

async function syncWindowBackground(theme: Theme) {
	if (!isTauri()) return;
	try {
		const core = await import("@tauri-apps/api/core");
		// light: #ffffff = (255, 255, 255), dark: #181818 = (24, 24, 24)
		const [r, g, b] = theme === "dark" ? [24, 24, 24] : [255, 255, 255];
		await core.invoke("set_window_background", { r, g, b });
	} catch {
		// ignore
	}
}

export function getTheme(): Theme {
	if (typeof document === "undefined") return "light";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
	const root = document.documentElement;
	root.classList.toggle("dark", theme === "dark");
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		/* ignore */
	}
	void syncWindowBackground(theme);
}

export function toggleTheme(): Theme {
	const next: Theme = getTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

export function useTheme(): Theme {
	const [theme, setThemeState] = useState<Theme>(getTheme);
	useEffect(() => {
		const observer = new MutationObserver(() => setThemeState(getTheme()));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);
	// Sync window background on mount and theme change
	useEffect(() => {
		void syncWindowBackground(theme);
	}, [theme]);
	return theme;
}
