import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme, useThemeId, type Theme } from "@/lib/theme";

/**
 * Terminal — a real interactive terminal (xterm.js) backed by a local PTY
 * exposed over WebSocket by the sidecar (`packages/pty/pty-server.ts`).
 *
 * Each mounted instance owns one WS connection → one PTY shell. When the pane
 * is unmounted the shell is killed. `ptyPort` comes from the session state
 * (`get_state` → `ptyPort`); if it is missing the PTY server could not start
 * and we show a graceful message.
 *
 * `visible` controls whether the pane is currently shown (e.g. the active tab
 * in a multi-tab dock). The xterm instance is kept mounted while hidden so the
 * PTY session survives tab switches; when visibility returns we re-fit the
 * terminal to its new pixel size.
 *
 * The terminal's color theme follows the app theme (light/dark) — the same
 * tokens used by the rest of the UI (`--bg`, `--fg`, …). Switching themes
 * updates the xterm colors live without restarting the shell.
 */

/** Probe element used to resolve var()/color-mix() to concrete colors for xterm. */
let colorProbe: HTMLSpanElement | null = null;
function cssColor(expr: string): string | null {
	if (!colorProbe) {
		colorProbe = document.createElement("span");
		colorProbe.style.display = "none";
		document.documentElement.appendChild(colorProbe);
	}
	colorProbe.style.color = "";
	colorProbe.style.color = expr;
	const c = getComputedStyle(colorProbe).color;
	// Unresolvable expressions compute to the inherited/default color or "";
	// treat transparent as unresolved too.
	return c && c !== "rgba(0, 0, 0, 0)" ? c : null;
}
const cssVar = (name: string, fallback: string): string => cssColor(`var(--${name})`) ?? fallback;

/** xterm.js theme derived live from the app's CSS tokens — follows built-in and custom themes. */
function xtermTheme(theme: Theme): Record<string, string> {
	const dark = theme === "dark";
	// Bright ANSI shades nudge the base color toward white (dark) or black (light).
	const bright = (base: string, fallback: string) =>
		cssColor(`color-mix(in srgb, ${base} 82%, ${dark ? "#ffffff" : "#000000"})`) ?? fallback;
	const bg = cssVar("bg", dark ? "#181818" : "#ffffff");
	const fg = cssVar("fg", dark ? "#ececec" : "#0d0d0d");
	const muted = cssVar("muted", dark ? "#8e8e93" : "#8f8f92");
	// Light mode: wash the chromatic ANSI colors 20% toward white so prompt
	// segments read as soft tints instead of saturated blocks; the contrast
	// floor keeps fg text legible on both roles.
	const chroma = (token: string, fallback: string): string =>
		dark
			? cssVar(token, fallback)
			: (cssColor(`color-mix(in srgb, var(--${token}) 80%, #ffffff)`) ?? cssVar(token, fallback));
	const danger = chroma("danger", dark ? "#ff6363" : "#e03131");
	const success = chroma("success", dark ? "#30d158" : "#34c759");
	const warning = chroma("warning", dark ? "#fbbf24" : "#d97706");
	const accent = chroma("accent", dark ? "#30d158" : "#1a7f37");
	const link = chroma("link", dark ? "#56d364" : "#1a7f37");
	const purple = chroma("retro-purple", dark ? "#9775fa" : "#7048e8");
	return {
		background: bg,
		foreground: fg,
		cursor: fg,
		cursorAccent: bg,
		selectionBackground: cssVar("surface-2", dark ? "#2a2a2a" : "#ececed"),
		// ANSI "black" doubles as fg and bg; soften it off the pure extremes so
		// prompt segments (bg=color + fg=black) stay readable in both modes.
		black: cssColor(`color-mix(in srgb, var(--fg) ${dark ? 38 : 65}%, var(--bg))`) ?? muted,
		red: danger,
		green: success,
		yellow: warning,
		blue: accent,
		magenta: purple,
		cyan: link,
		white: dark ? fg : muted,
		brightBlack: muted,
		brightRed: bright(danger, danger),
		brightGreen: bright(success, success),
		brightYellow: bright(warning, warning),
		brightBlue: bright(accent, accent),
		brightMagenta: bright(purple, purple),
		brightCyan: bright(link, link),
		// brightWhite is the conventional "text on colored segment" color —
		// keep it near-white even in light mode so powerline-style prompts work.
		brightWhite: cssColor(`color-mix(in srgb, #ffffff ${dark ? 15 : 92}%, var(--fg))`) ?? fg,
	};
}

export default function Terminal({
	workspace,
	ptyPort,
	visible = true,
}: {
	workspace?: string | null;
	ptyPort?: number;
	visible?: boolean;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const themeId = useThemeId();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error" | "unavailable">(
		ptyPort ? "connecting" : "unavailable",
	);

	useEffect(() => {
		if (!ptyPort) {
			setStatus("unavailable");
			return;
		}
		const container = containerRef.current;
		if (!container) return;

		const term = new XTerm({
			fontFamily:
				'"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Pizza Nerd Icons", monospace',
			fontSize: 12,
			fontWeight: 500,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: true,
			// Prompt segments often pair a saturated bg with an arbitrary fg —
			// xterm lifts the fg toward WCAG AA contrast against its cell bg.
			minimumContrastRatio: 4.5,
			theme: xtermTheme(theme),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();
		xtermRef.current = term;
		fitRef.current = fit;

		setStatus("connecting");

		let closedByUs = false;
		const wsUrl = `ws://127.0.0.1:${ptyPort}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		const send = (obj: Record<string, unknown>): void => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
		};

		const spawn = (): void => {
			const cols = term.cols ?? 80;
			const rows = term.rows ?? 24;
			send({ type: "spawn", cwd: workspace ?? undefined, cols, rows });
		};

		ws.onopen = () => {
			setStatus("ready");
			spawn();
		};
		ws.onmessage = (ev) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			switch (msg.type) {
				case "output":
					if (typeof msg.data === "string") term.write(msg.data);
					break;
				case "ready":
					break;
				case "exit":
					term.writeln(`\r\n\x1b[33m[${t("terminal.exited")}${typeof msg.exitCode === "number" ? " " + msg.exitCode : ""}]\x1b[0m`);
					break;
				case "error":
					setStatus("error");
					term.writeln(`\r\n\x1b[31m${typeof msg.message === "string" ? msg.message : "error"}\x1b[0m`);
					break;
			}
		};
		ws.onerror = () => {
			setStatus("error");
			term.writeln(`\r\n\x1b[31m${t("terminal.connectionError")}\x1b[0m`);
		};
		ws.onclose = () => {
			if (!closedByUs) setStatus("error");
		};

		const disposableInput = term.onData((data) => send({ type: "input", data }));
		const disposableResize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

		const onResize = (): void => {
			// Skip fitting while the pane is hidden (zero size) — we re-fit on
			// visibility change instead, which avoids collapsing the PTY to 0×0.
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			try { fit.fit(); } catch { /* ignore */ }
		};
		const resizeObserver = new ResizeObserver(onResize);
		resizeObserver.observe(container);
		// Fit once layout settles.
		const fitTimer = setTimeout(() => { try { fit.fit(); } catch { /* ignore */ } }, 0);

		return () => {
			closedByUs = true;
			clearTimeout(fitTimer);
			resizeObserver.disconnect();
			disposableInput.dispose();
			disposableResize.dispose();
			try { ws.close(); } catch { /* ignore */ }
			wsRef.current = null;
			term.dispose();
			xtermRef.current = null;
			fitRef.current = null;
		};
		// theme is intentionally read at creation time only; live theme
		// changes are handled by the separate effect below so the PTY session
		// is never restarted on a theme switch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ptyPort, workspace, t]);

	// Apply theme changes live to the existing xterm instance without
	// restarting the shell. xterm picks up `options.theme` on assignment.
	// themeId covers same-mode switches between two custom themes.
	useEffect(() => {
		const term = xtermRef.current;
		if (!term) return;
		term.options.theme = xtermTheme(theme) as unknown as typeof term.options.theme;
	}, [theme, themeId]);

	// Re-fit when the pane becomes visible again (e.g. switching back to its
	// tab). While hidden the container has zero size, so we must wait until it
	// is shown to compute correct cols/rows.
	useEffect(() => {
		if (!visible) return;
		const fit = fitRef.current;
		const container = containerRef.current;
		if (!fit || !container) return;
		// Defer two frames so layout has flushed the display change.
		const id = requestAnimationFrame(() => requestAnimationFrame(() => {
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			try { fit.fit(); } catch { /* ignore */ }
		}));
		return () => cancelAnimationFrame(id);
	}, [visible]);

	// The container is always mounted; xterm paints into it when a ptyPort exists.
	return (
		<div className="relative h-full w-full bg-bg">
			<div ref={containerRef} className="h-full w-full" />
			{status === "unavailable" && (
				<div className="absolute inset-0 flex items-center justify-center px-4 text-center">
					<div className="font-mono text-xs text-muted">{t("terminal.unavailable")}</div>
				</div>
			)}
			{status === "error" && (
				<div className="pointer-events-none absolute right-2 top-2 rounded bg-surface-2/80 px-1.5 py-0.5 font-mono text-[10px] text-danger">
					{t("terminal.connectionError")}
				</div>
			)}
		</div>
	);
}
