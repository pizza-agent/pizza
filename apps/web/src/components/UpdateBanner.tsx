import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, X } from "lucide-react";
import { checkAppUpdate, openExternal, type AppUpdateInfo } from "@/lib/transport";
import { appUpdateProgressLabel, startAppUpdate, useAppUpdate } from "@/lib/app-update";
import { cn } from "@/lib/utils";

const LAST_CHECK_KEY = "pizza-update-last-check";
const DISMISSED_KEY = "pizza-update-dismissed-version";
/** Throttle automatic checks to once per day. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Slim, dismissible "update available" bar at the top of the main area.
 *
 * Checks GitHub releases via the Rust bridge at most once a day (throttled in
 * localStorage); a dismissed version stays dismissed until a newer release
 * appears. Renders nothing when up to date, outside Tauri, or on error.
 */
export function UpdateBanner() {
	const { t } = useTranslation();
	const [info, setInfo] = useState<AppUpdateInfo | null>(null);
	const update = useAppUpdate();
	const running = update.status === "running";

	useEffect(() => {
		let cancelled = false;
		const run = async () => {
			// Throttle: at most one automatic check per day.
			try {
				const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? "0");
				if (Date.now() - last < CHECK_INTERVAL_MS) return;
				localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
			} catch {
				/* localStorage unavailable — just check */
			}
			const result = await checkAppUpdate();
			if (!cancelled && result?.updateAvailable) setInfo(result);
		};
		void run();
		return () => {
			cancelled = true;
		};
	}, []);

	if (!info?.updateAvailable) return null;

	let dismissedVersion: string | null = null;
	try {
		dismissedVersion = localStorage.getItem(DISMISSED_KEY);
	} catch {
		/* ignore */
	}
	if (dismissedVersion && dismissedVersion === info.latestVersion) return null;

	const dismiss = () => {
		try {
			localStorage.setItem(DISMISSED_KEY, info.latestVersion ?? "");
		} catch {
			/* ignore */
		}
		setInfo(null);
	};

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-between gap-3 border-b border-accent/30",
				"bg-accent/10 px-4 py-1.5 text-xs text-fg",
			)}
			data-testid="update-banner"
		>
			<span className="truncate" title={update.status === "error" ? update.error : undefined}>
				{update.status === "error"
					? t("update.failed", { error: update.error })
					: t("update.banner", { version: info.latestVersion })}
			</span>
			<span className="flex shrink-0 items-center gap-2">
				{update.status === "error" && (
					<button
						type="button"
						className="rounded-md px-2 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						onClick={() => void openExternal(info.downloadUrl ?? info.releaseUrl)}
					>
						{t("update.manualDownload")}
					</button>
				)}
				<button
					type="button"
					disabled={running}
					className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-accent-fg transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-80"
					onClick={() => void startAppUpdate()}
				>
					{running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
					{appUpdateProgressLabel(t, update) ?? t(update.status === "error" ? "update.retry" : "update.install")}
				</button>
				{!running && (
					<button
						type="button"
						className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
						onClick={dismiss}
						title={t("common.dismiss")}
					>
						<X className="h-3 w-3" />
					</button>
				)}
			</span>
		</div>
	);
}
