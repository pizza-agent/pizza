/**
 * ExtensionUiHost — renders `extension_ui_request` frames pushed by the RPC
 * sidecar (ctx.ui.* calls from extensions, e.g. the pet extension).
 *
 * - Dialogs (select/confirm/input/editor/page) show as modals and answer via
 *   `respondExtensionUi`.
 * - `setWidget`/`setStatus` render inline strips (mount where you want them —
 *   AgentView puts this host just above the Composer).
 * - `notify` shows transient toasts; `setTitle` maps to document.title;
 *   `set_editor_text` prefills the Composer.
 *
 * Mount once per workspace view. Requests carry `_cwd`; we only serve the
 * workspace prop they belong to.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { respondExtensionUi, subscribeExtensionUi } from "@/lib/transport";
import { prefillComposer } from "@/lib/composer-prefill";
import { Button, Modal } from "@/components/ui";

type RawRequest = Record<string, unknown> & { _cwd?: string };

interface PageItemWire {
	id: string;
	label: string;
	description?: string;
	preview?: string[];
}

interface PendingDialog extends RawRequest {
	method: string;
}

interface Toast {
	id: number;
	message: string;
	notifyType?: string;
}

let toastCounter = 0;

const PET_WIDGET_KEY = "pet-widget";

export function ExtensionUiHost({ workspace }: { workspace: string }) {
	const [dialog, setDialog] = useState<PendingDialog | null>(null);
	const queueRef = useRef<PendingDialog[]>([]);
	const [widgets, setWidgets] = useState<Map<string, { lines: string[]; below: boolean }>>(new Map());
	const [statuses, setStatuses] = useState<Map<string, string>>(new Map());
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [textValue, setTextValue] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const respond = (id: string, payload: Record<string, unknown>) =>
		respondExtensionUi({ id, ...payload });

	const closeDialog = (next?: PendingDialog | null) => {
		setDialog(next ?? queueRef.current.shift() ?? null);
		setTextValue("");
		setSelectedId(null);
	};

	const pushToast = (message: string, notifyType?: string) => {
		const id = ++toastCounter;
		setToasts((cur) => [...cur.slice(-4), { id, message, notifyType }]);
		setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4000);
	};

	useEffect(() => {
		let disposed = false;
		let un: (() => void) | undefined;
		void subscribeExtensionUi((req) => {
			if (disposed) return;
			if (req._cwd && req._cwd !== workspace) return;
			handleRequest(req);
		}).then((fn) => {
			if (disposed) fn();
			else un = fn;
		});
		return () => {
			disposed = true;
			un?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace]);

	const handleRequest = (req: RawRequest) => {
		const method = req.method as string;
		switch (method) {
			case "notify":
				pushToast(String(req.message ?? ""), req.notifyType as string | undefined);
				break;
			case "setStatus": {
				const key = String(req.statusKey);
				const text = req.statusText as string | undefined;
				setStatuses((cur) => {
					const next = new Map(cur);
					if (text === undefined) next.delete(key);
					else next.set(key, text);
					return next;
				});
				break;
			}
			case "setWidget": {
				const key = String(req.widgetKey);
				const lines = req.widgetLines as string[] | undefined;
				const below = (req.widgetPlacement as string) !== "aboveEditor";
				setWidgets((cur) => {
					const next = new Map(cur);
					if (lines === undefined) next.delete(key);
					else next.set(key, { lines, below });
					return next;
				});
				break;
			}
			case "setTitle":
				if (typeof req.title === "string") document.title = req.title;
				break;
			case "set_editor_text":
				prefillComposer((req._cwd as string) ?? workspace, String(req.text ?? ""));
				break;
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "page": {
				const pending = req as PendingDialog;
				setDialog((cur) => {
					if (cur) {
						queueRef.current.push(pending);
						return cur;
					}
					return pending;
				});
				break;
			}
		}
	};

	const dialogKind = dialog?.method;

	const cancelDialog = () => {
		if (!dialog) return;
		if (dialogKind === "page") respond(String(dialog.id), { page: { kind: "cancel" } });
		else respond(String(dialog.id), { cancelled: true });
		closeDialog();
	};

	const renderDialogBody = (): ReactNode => {
		if (!dialog) return null;
		switch (dialog.method) {
			case "select": {
				const options = (dialog.options as string[]) ?? [];
				return (
					<ul className="space-y-1">
						{options.map((opt) => (
							<li key={opt}>
								<button
									type="button"
									className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
									onClick={() => {
										respond(String(dialog.id), { value: opt });
										closeDialog();
									}}
								>
									{opt}
								</button>
							</li>
						))}
					</ul>
				);
			}
			case "confirm":
				return <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{String(dialog.message ?? "")}</p>;
			case "input":
			case "editor": {
				const isEditor = dialog.method === "editor";
				return isEditor ? (
					<textarea
						autoFocus
						className="h-40 w-full rounded-lg border border-border bg-surface p-2 font-mono text-sm text-fg"
						defaultValue={String(dialog.prefill ?? "")}
						onChange={(e) => setTextValue(e.target.value)}
					/>
				) : (
					<input
						autoFocus
						className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg"
						placeholder={String(dialog.placeholder ?? "")}
						onChange={(e) => setTextValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								respond(String(dialog.id), { value: textValue });
								closeDialog();
							}
						}}
					/>
				);
			}
			case "page": {
				const items = (dialog.items as PageItemWire[]) ?? [];
				const actions = (dialog.actions as Array<{ key: string; label: string }>) ?? [];
				const selected = items.find((i) => i.id === selectedId) ?? items[0];
				return (
					<div className="flex gap-4">
						<ul className="min-w-40 space-y-1">
							{items.map((item) => (
								<li key={item.id}>
									<button
										type="button"
										className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 ${
											selected?.id === item.id ? "bg-surface-2 text-accent" : ""
										}`}
										onMouseEnter={() => setSelectedId(item.id)}
										onClick={() => {
											respond(String(dialog.id), { page: { kind: "select", itemId: item.id } });
											closeDialog();
										}}
									>
										<div className="font-medium">{item.label}</div>
										{item.description && <div className="text-xs text-muted">{item.description}</div>}
									</button>
								</li>
							))}
						</ul>
						{selected?.preview && (
							<pre className="rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-tight text-fg">
								{selected.preview.join("\n")}
							</pre>
						)}
						{actions.length > 0 && (
							<div className="flex flex-col justify-end gap-1">
								{actions.map((a) => (
									<Button
										key={a.key}
										size="sm"
										tone="neutral"
										variant="outline"
										onClick={() => {
											respond(String(dialog.id), {
												page: { kind: "action", action: a.key, itemId: selected?.id },
											});
											closeDialog();
										}}
									>
										{a.label} ({a.key})
									</Button>
								))}
							</div>
						)}
					</div>
				);
			}
			default:
				return null;
		}
	};

	// The pet widget and its status are never rendered inline — the pet lives
	// in the floating desktop window and the sidebar menu only.
	const widgetEntries = [...widgets.entries()].filter(
		([key, w]) => w.lines.length > 0 && key !== PET_WIDGET_KEY,
	);
	const statusEntries = [...statuses.entries()].filter(([key]) => key !== "pet");

	return (
		<>
			{/* Inline strips: widget lines + statuses (above the Composer). */}
			{(widgetEntries.length > 0 || statusEntries.length > 0) && (
				<div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1 px-2">
					{widgetEntries.map(([key, w]) => (
						<div key={key} className="w-fit">
							<pre className="w-fit rounded-lg border border-border bg-surface px-3 py-1 font-mono text-xs leading-tight text-accent">
								{w.lines.join("\n")}
							</pre>
						</div>
					))}
					{statusEntries.length > 0 && (
						<div className="flex flex-wrap gap-3 text-xs text-muted">
							{statusEntries.map(([, s], i) => <span key={i}>{s}</span>)}
						</div>
					)}
				</div>
			)}

			{/* Dialog */}
			{dialog && (
				<Modal
					open
					onClose={cancelDialog}
					title={String(dialog.title ?? "")}
					size="sm"
					footer={
						<>
							{(dialogKind === "confirm") && (
								<>
									<Button tone="neutral" variant="outline" size="sm" onClick={cancelDialog}>
										Cancel
									</Button>
									<Button
										tone="accent"
										size="sm"
										onClick={() => {
											respond(String(dialog.id), { confirmed: true });
											closeDialog();
										}}
									>
										OK
									</Button>
								</>
							)}
							{(dialogKind === "input" || dialogKind === "editor") && (
								<Button
									tone="accent"
									size="sm"
									onClick={() => {
										respond(String(dialog.id), { value: textValue });
										closeDialog();
									}}
								>
									OK
								</Button>
							)}
						</>
					}
				>
					{renderDialogBody()}
				</Modal>
			)}

			{/* Toasts */}
			{createPortal(
				<div className="pointer-events-none fixed right-4 bottom-4 z-[90] flex flex-col gap-2">
					{toasts.map((t) => (
						<div
							key={t.id}
							className={`pointer-events-auto rounded-xl border px-4 py-2 text-sm shadow-lg ${
								t.notifyType === "error"
									? "border-red-500/40 bg-surface text-red-400"
									: t.notifyType === "warning"
										? "border-gold/40 bg-surface text-gold"
										: "border-border bg-surface text-fg"
							}`}
						>
							{t.message}
						</div>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}