import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ExternalLink, FileDiff, FileMinus, FilePen, FilePlus } from "lucide-react";
import { DiffViewer } from "./DiffViewer";
import { openInEditor } from "@/lib/transport";
import { countDiffStats, type FileChange } from "@/lib/file-changes";
import { cn, isRemoteWorkspaceKey } from "@/lib/utils";

const OPERATION_ICON = {
	create: FilePlus,
	modify: FilePen,
	delete: FileMinus,
} as const;

const OPERATION_CLASS = {
	create: "text-success",
	modify: "text-warning",
	delete: "text-danger",
} as const;

function operationLabel(operation: FileChange["operation"], t: (key: string) => string): string {
	return t(`conversation.fileChanges.${operation}`);
}

function changeKey(change: FileChange): string {
	return `${change.toolCallId ?? ""}:${change.path}:${change.operation}`;
}

/**
 * Codex-style file-change summary for one tool card. The list is always
 * visible; the unified diff is expanded on demand so a large write does not
 * dominate the conversation.
 */
export function FileChangeCard({
	changes,
	workspace,
	className,
}: {
	changes: FileChange[];
	workspace?: string | null;
	className?: string;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [actionError, setActionError] = useState<{ path: string; message: string } | null>(null);
	if (changes.length === 0) return null;

	return (
		<div className={cn("overflow-hidden rounded-xl border border-border/70 bg-surface-2/30", className)}>
			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs font-medium text-fg">
				<FileDiff className="h-3.5 w-3.5 text-muted" />
				<span>{t("conversation.fileChanges.title", { count: changes.length })}</span>
			</div>
			<div className="divide-y divide-border/50">
				{changes.map((change, index) => {
					const key = `${changeKey(change)}:${index}`;
					const open = expanded === key;
					const Icon = OPERATION_ICON[change.operation];
					const stats = countDiffStats(change.diff);
					const hasStats = change.additions !== undefined || change.deletions !== undefined;
					const additions = change.additions ?? stats.additions;
					const deletions = change.deletions ?? stats.deletions;
					const canOpen = Boolean(workspace) && change.operation !== "delete" && !isRemoteWorkspaceKey(workspace ?? "");
					return (
						<div key={key}>
							<div className="flex items-center gap-2 px-3 py-1.5">
								<button
									type="button"
									onClick={() => setExpanded(open ? null : key)}
									className="flex min-w-0 flex-1 items-center gap-2 text-left"
									title={open ? t("conversation.fileChanges.collapse") : t("conversation.fileChanges.expand")}
								>
									<Icon className={cn("h-3.5 w-3.5 shrink-0", OPERATION_CLASS[change.operation])} />
									<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{change.path}</span>
									<span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
										{operationLabel(change.operation, t)}
									</span>
									{hasStats && (
										<span className="shrink-0 font-mono text-[10px] tabular-nums">
											<span className="text-success">+{additions}</span>{" "}
											<span className="text-danger">−{deletions}</span>
										</span>
									)}
									<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} />
								</button>
								{workspace && (
									<button
										type="button"
										disabled={!canOpen}
										onClick={() => {
											setActionError(null);
											void openInEditor(workspace, change.path).catch((error) => {
												setActionError({
													path: change.path,
													message: error instanceof Error ? error.message : String(error),
												});
											});
										}}
										className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted/70 transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
										title={canOpen ? t("conversation.fileChanges.openInEditor") : t("conversation.fileChanges.openUnavailable")}
									>
										<ExternalLink className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
							{actionError?.path === change.path && (
								<div className="px-3 pb-1 text-[10px] text-danger">
									{t("conversation.fileChanges.openFailed", { error: actionError.message })}
								</div>
							)}
							{open && (
								<div className="max-h-80 overflow-auto border-t border-border/50 bg-bg">
									{change.diff ? (
										<DiffViewer text={change.diff} wrap />
									) : (
										<div className="px-3 py-2 text-xs text-muted">{t("conversation.fileChanges.noDiff")}</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
