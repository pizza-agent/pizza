/**
 * BootSplash — the desktop launch screen, and a theme extension point.
 *
 * Stable contract (themes target it from `web.splash.css` / `web.css`, so
 * keep it backwards compatible — add hooks, never rename them):
 *
 *   html[data-pizza-phase="boot" | "ready"]
 *       "boot" from first paint (index.html) until the splash starts leaving.
 *   .pizza-splash[data-state="active" | "exiting"]
 *       Fixed full-window root. The exit unmounts after the root's longest
 *       transition/animation (capped), so a theme can replace the default
 *       fade with its own `[data-state="exiting"]` motion.
 *     .pizza-splash__backdrop   empty, aria-hidden layer for decorative art
 *     .pizza-splash__content
 *       .pizza-splash__icon     brand mark (theme web.icon, or the pizza slice)
 *       .pizza-splash__message  status text
 *
 * `web.splash.css` is mounted only while the splash is on screen;
 * `web.splash.minDurationMs` holds it so the theme's motion can play on fast
 * starts. Both come from the persisted theme snapshot because the splash
 * renders before the theme catalog is fetched from the agent.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrandIcon } from "@/components/BrandIcon";
import { getSplashSpec, type SplashSpec } from "@/lib/theme";

type SplashState = "active" | "exiting" | "gone";

const STYLE_ID = "pizza-theme-splash";
/** A looping theme animation on the root must not keep the splash up forever. */
const MAX_EXIT_MS = 2000;

function setPhase(phase: "boot" | "ready"): void {
	document.documentElement.dataset.pizzaPhase = phase;
}

/** Longest finite transition/animation (duration + delay) currently applied to el, in ms. */
function longestMotionMs(el: HTMLElement): number {
	const cs = getComputedStyle(el);
	const toMs = (list: string) =>
		list.split(",").map((s) => (s.trim().endsWith("ms") ? parseFloat(s) : parseFloat(s) * 1000) || 0);
	const span = (durations: string, delays: string) => {
		const d = toMs(durations);
		const l = toMs(delays);
		return Math.max(0, ...d.map((ms, i) => ms + (l[i % l.length] ?? 0)));
	};
	return Math.min(
		MAX_EXIT_MS,
		Math.max(span(cs.transitionDuration, cs.transitionDelay), span(cs.animationDuration, cs.animationDelay)),
	);
}

export function BootSplash({ active, message }: { active: boolean; message?: string }) {
	const { t } = useTranslation();
	const [state, setState] = useState<SplashState>(active ? "active" : "gone");
	const [spec, setSpec] = useState<SplashSpec>(getSplashSpec);
	const shownAtRef = useRef(performance.now());
	const rootRef = useRef<HTMLDivElement>(null);

	// (Re)show: refresh the spec — the theme may have changed since the last boot.
	useEffect(() => {
		if (!active || state === "active") return;
		setSpec(getSplashSpec());
		shownAtRef.current = performance.now();
		setState("active");
	}, [active, state]);

	// Ready: honor the theme's minimum display time, then start the exit.
	useEffect(() => {
		if (active || state !== "active") return;
		const remaining = spec.minDurationMs - (performance.now() - shownAtRef.current);
		const id = setTimeout(() => setState("exiting"), Math.max(0, remaining));
		return () => clearTimeout(id);
	}, [active, state, spec.minDurationMs]);

	// Exiting: wait for the root's exit motion, then unmount.
	useEffect(() => {
		if (state !== "exiting" || !rootRef.current) return;
		const id = setTimeout(() => setState("gone"), longestMotionMs(rootRef.current));
		return () => clearTimeout(id);
	}, [state]);

	// Phase tracks what is on screen; leaving the tree always means "ready".
	useLayoutEffect(() => setPhase(state === "active" ? "boot" : "ready"), [state]);
	useEffect(() => () => setPhase("ready"), []);

	// Theme splash CSS lives exactly as long as the splash does.
	const mounted = state !== "gone";
	useLayoutEffect(() => {
		if (!mounted || !spec.css) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = spec.css;
		document.head.appendChild(style);
		return () => style.remove();
	}, [mounted, spec.css]);

	if (!mounted) return null;
	return (
		<div ref={rootRef} className="pizza-splash" data-state={state} role="status" aria-live="polite" aria-busy={state === "active"}>
			<div className="pizza-splash__backdrop" aria-hidden />
			<div className="pizza-splash__content">
				<div className="pizza-splash__icon">
					{spec.icon ? <img src={spec.icon} alt="" width={48} height={48} /> : <BrandIcon size={48} />}
				</div>
				<p className="pizza-splash__message">{message ?? t("common.starting")}</p>
			</div>
		</div>
	);
}
