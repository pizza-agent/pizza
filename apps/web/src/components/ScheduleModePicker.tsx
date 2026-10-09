import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import type { ScheduleMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

/**
 * The 6 visual schedule modes (plus an "advanced (cron)" entry). Matches
 * the screenshot the user shared:
 *
 *   - Every N minutes
 *   - Every N hours
 *   - Every day at fixed times
 *   - Weekdays at fixed times
 *   - Weekly on chosen weekdays at fixed times
 *   - Monthly on chosen days at fixed times
 *   - Cron expression (advanced)
 */
const VISUAL_MODES: ScheduleMode[] = [
	"every_n_minutes",
	"every_n_hours",
	"daily",
	"weekdays",
	"weekly",
	"monthly",
];

/**
 * Single-select dropdown for picking a schedule mode. Renders the current
 * label as the trigger button, and expands a popup menu with all options.
 *
 * Closes on outside click or Escape. Mirrors the trigger style of the
 * existing Composer menus (approval / model selectors) so it feels native.
 */
export function ScheduleModePicker({
	value,
	onChange,
}: {
	value: ScheduleMode;
	onChange: (next: ScheduleMode) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const currentLabel = t(`schedule.modes.${value}`);

	return (
		<div ref={wrapRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className={cn(
					"flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm transition-colors",
					open
						? "border-accent bg-surface text-fg"
						: "border-border bg-surface text-fg hover:border-accent/40",
				)}
			>
				<span className="truncate">{currentLabel}</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-muted transition-transform",
						open && "rotate-180 text-accent",
					)}
				/>
			</button>
			{open && (
				<div className={cn("absolute left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}>
					{VISUAL_MODES.map((mode) => {
						const selected = value === mode;
						return (
							<button
								key={mode}
								type="button"
								onClick={() => {
									onChange(mode);
									setOpen(false);
								}}
								className={cn(
									"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
									selected
										? "bg-accent/10 text-fg"
										: "text-muted hover:bg-surface-2 hover:text-fg",
								)}
							>
								<span>{t(`schedule.modes.${mode}`)}</span>
								{selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
							</button>
						);
					})}
					<div className="my-1 border-t border-border/60" />
					<button
						type="button"
						onClick={() => {
							onChange("cron");
							setOpen(false);
						}}
						className={cn(
							"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
							value === "cron"
								? "bg-accent/10 text-fg"
								: "text-muted hover:bg-surface-2 hover:text-fg",
						)}
					>
						<span>{t("schedule.modes.cron")}</span>
						{value === "cron" && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
					</button>
				</div>
			)}
		</div>
	);
}