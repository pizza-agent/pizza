import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, EllipsisVertical, X } from "lucide-react";
import {
	PixelAlert,
	PixelBadge as PxlBadge,
	PixelButton as PxlButton,
	PixelEmptyState as PxlEmptyState,
	PixelModal as PxlModal,
	PixelSpinner as PxlSpinner,
	useEscape,
	type Tone,
} from "@pxlkit/ui-kit";
import { cn } from "@/lib/utils";
import { toggleTheme, useTheme } from "@/lib/theme";
import { setConfirmHostHandler, type ConfirmRequest } from "@/lib/confirm";
import { Z } from "@/lib/z-index";

const toneMap: Record<string, Tone> = {
	neutral: "neutral",
	success: "green",
	warning: "gold",
	danger: "red",
	accent: "cyan",
};

export function Card({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-surface px-5 py-4",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<div className="mb-8 flex items-start justify-between gap-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-fg">
					{title}
				</h1>
				{description && (
					<p className="mt-1.5 text-sm text-muted">{description}</p>
				)}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}

export function Badge({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: keyof typeof toneMap;
}) {
	return (
		<PxlBadge tone={toneMap[tone]} size="sm">
			{children}
		</PxlBadge>
	);
}

export function Button({
	children,
	tone = "accent",
	variant,
	size = "md",
	iconLeft,
	iconRight,
	loading,
	fullWidth,
	disabled,
	onClick,
	type,
	title,
	className,
}: {
	children?: ReactNode;
	tone?: keyof typeof toneMap;
	variant?: "solid" | "soft" | "outline" | "ghost";
	size?: "sm" | "md" | "lg";
	iconLeft?: ReactNode;
	iconRight?: ReactNode;
	loading?: boolean;
	fullWidth?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	type?: "button" | "submit" | "reset";
	title?: string;
	className?: string;
}) {
	return (
		<PxlButton
			tone={toneMap[tone]}
			variant={variant}
			size={size}
			iconLeft={iconLeft}
			iconRight={iconRight}
			loading={loading}
			fullWidth={fullWidth}
			disabled={disabled}
			onClick={onClick}
			type={type}
			title={title}
			className={className}
		>
			{children}
		</PxlButton>
	);
}

/**
 * A compact square icon-only button for dense toolbars (dock headers, preview
 * panes). `active` renders the accent state, used for toggles like line-wrap.
 */
export function IconButton({
	children,
	onClick,
	title,
	active,
	disabled,
	className,
}: {
	children: ReactNode;
	onClick?: () => void;
	title?: string;
	active?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			disabled={disabled}
			className={cn(
				"flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40",
				active ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
				className,
			)}
		>
			{children}
		</button>
	);
}

export function StatusDot({
	tone,
}: {
	tone: "success" | "warning" | "danger" | "neutral";
}) {
	const color = {
		success: "bg-success",
		warning: "bg-warning",
		danger: "bg-danger",
		neutral: "bg-muted",
	}[tone];
	return (
		<span className="relative inline-flex h-2 w-2">
			{tone === "success" && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
						color,
					)}
				/>
			)}
			<span className={cn("relative inline-block h-2 w-2 rounded-full", color)} />
		</span>
	);
}

export function Spinner() {
	return <PxlSpinner size="sm" decorative />;
}

export function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<label className="block">
			<span className="label">{label}</span>
			{children}
			{hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
		</label>
	);
}

export function EmptyState({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<PxlEmptyState
			title={title}
			description={description ?? ""}
			action={action}
		/>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	const { t } = useTranslation();
	return (
		<div className="mb-4">
			<PixelAlert tone="red" label={t("common.error")} message={message} />
		</div>
	);
}

export function Modal({
	open,
	onClose,
	title,
	children,
	footer,
	size = "lg",
	backdrop = true,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	footer?: ReactNode;
	size?: "sm" | "md" | "lg" | "xl" | "full";
	backdrop?: boolean;
}) {
	if (!backdrop) {
		return (
			<FloatingDialog open={open} onClose={onClose} title={title} footer={footer} size={size}>
				{children}
			</FloatingDialog>
		);
	}
	return (
		<PxlModal open={open} onClose={onClose} title={title} footer={footer} size={size}>
			{children}
		</PxlModal>
	);
}

/** Lightweight floating dialog — no full-screen backdrop scrim. Renders as a
 *  small positioned card with a subtle shadow, so the page behind stays
 *  visible and interactive. Closes on Escape or click-outside. */
function FloatingDialog({
	open,
	onClose,
	title,
	children,
	footer,
	size = "md",
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	footer?: ReactNode;
	size?: "sm" | "md" | "lg" | "xl" | "full";
}) {
	useEscape(onClose, open);
	if (!open) return null;

	const maxW =
		size === "sm" ? "max-w-sm" :
		size === "lg" ? "max-w-2xl" :
		size === "xl" ? "max-w-4xl" :
		size === "full" ? "max-w-[95vw]" :
		"max-w-md";

	return (
		<div className={cn("fixed inset-0 flex items-start justify-center p-4 pt-[15vh]", Z.modal)} onClick={onClose}>
			<div
				className={cn(
					"relative w-full rounded-lg border border-border bg-surface shadow-2xl",
					maxW,
				)}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<h4 className="text-sm font-semibold text-fg">{title}</h4>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
				<div className="px-4 py-4 text-sm text-muted">{children}</div>
				{footer && (
					<div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}

export function MiniSwitch({
	checked,
	onChange,
	disabled,
	tone = "green",
	"aria-label": ariaLabel,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	tone?: "green" | "accent";
	"aria-label"?: string;
}) {
	const onColor =
		tone === "accent"
			? "bg-[var(--accent)]"
			: "bg-success";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40",
				checked ? onColor : "bg-surface-2",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			<span
				className={cn(
					"absolute h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform",
					checked ? "translate-x-[19px]" : "translate-x-[2px]",
				)}
			/>
		</button>
	);
}

export function ThemeToggle() {
	const { t } = useTranslation();
	const theme = useTheme();
	const isDark = theme === "dark";
	return (
		<PxlButton
			tone="neutral"
			variant="ghost"
			size="sm"
			onClick={toggleTheme}
			title={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			iconLeft={<span className="text-xs">{isDark ? "☀" : "☾"}</span>}
		/>
	);
}

/**
 * A single menu entry. Either an action item (icon + label + click handler)
 * or a visual divider. Use the union shape to make dividers type-safe.
 */
export type ContextMenuItem =
	| {
			divider?: never;
			icon: typeof import("lucide-react").Folder;
			label: string;
			hint?: string;
			disabled?: boolean;
			danger?: boolean;
			onClick: () => void;
	  }
	| { divider: true };

export interface ContextMenuProps {
	/** Position in viewport coordinates (typically `e.clientX/Y`). */
	x: number;
	y: number;
	items: ContextMenuItem[];
	onDismiss: () => void;
}

const CONTEXT_MENU_MIN_WIDTH = 208;

/**
 * Rough menu height for viewport-fit logic — matches the row styles (py-1.5
 * rows, optional hint line, my-1 dividers, py-1 container padding).
 */
function estimateMenuHeight(items: ContextMenuItem[]): number {
	let h = 8; // container py-1
	for (const item of items) {
		if (item.divider) h += 9; // my-1 + 1px rule
		else h += item.hint ? 44 : 30; // py-1.5 + one or two text lines
	}
	return h;
}

/**
 * Floating context menu rendered as a `position: fixed` div with viewport
 * coordinates. Dismisses on outside mousedown or Escape (handled by the
 * caller via `onDismiss` — typically a window-level listener installed in
 * a `useEffect` while the menu is open).
 */
export function ContextMenu({ x, y, items, onDismiss }: ContextMenuProps) {
	// Clamp the menu inside the viewport so it does not overflow the
	// right/bottom edges. Width/height are estimates (item widths vary). When
	// the menu does not fit below the anchor point it opens upwards with its
	// bottom edge at the anchor, keeping it attached to the trigger/cursor
	// instead of jumping far above it.
	const clampedX = Math.max(8, Math.min(x, window.innerWidth - CONTEXT_MENU_MIN_WIDTH - 8));
	const estHeight = estimateMenuHeight(items);
	const clampedY =
		y + estHeight <= window.innerHeight - 8 ? y : Math.max(8, y - estHeight);

	// Portal to <body>: the menu is fixed-positioned in viewport coords, and
	// rendering it inline would trap its z-index inside ancestor stacking
	// contexts (e.g. @container cards), letting later siblings paint over it.
	return createPortal(
		<div
			className={cn("fixed min-w-52 rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}
			style={{ left: clampedX, top: clampedY }}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{items.map((item, i) => (
				item.divider ? (
					<div key={i} className="my-1 h-px bg-border" />
				) : (
					<ContextMenuRow
						key={i}
						item={item}
						onClick={() => {
							if (item.disabled) return;
							onDismiss();
							item.onClick();
						}}
					/>
				)
			))}
		</div>,
		document.body,
	);
}

function ContextMenuRow({
	item,
	onClick,
}: {
	item: Exclude<ContextMenuItem, { divider: true }>;
	onClick: () => void;
}) {
	const Icon = item.icon;
	return (
		<button
			type="button"
			disabled={item.disabled}
			onClick={onClick}
			title={item.hint}
			className={cn(
				"flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
				item.disabled
					? "cursor-not-allowed text-muted/40"
					: item.danger
						? "text-danger hover:bg-danger/10 hover:text-danger"
						: "text-fg hover:bg-surface-2",
			)}
		>
			<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate">{item.label}</span>
				{item.hint && (
					<span className="truncate text-[11px] font-normal text-muted">{item.hint}</span>
				)}
			</span>
		</button>
	);
}

/**
 * "More" (⋯) trigger button that opens a {@link ContextMenu} anchored below
 * and right-aligned with the button, flipping above it when space is tight —
 * matching the other dropdown menus in the app. Clicking the trigger again
 * toggles the menu closed. Collapses a row of action buttons into a single
 * compact icon — the menu items are supplied by the caller.
 */
export function MoreMenu({
	items,
	disabled,
	title,
	icon,
	triggerClassName,
	open,
	onOpenChange,
}: {
	items: ContextMenuItem[];
	disabled?: boolean;
	title?: string;
	/** Custom trigger icon; defaults to a vertical ellipsis. */
	icon?: ReactNode;
	/** Replaces the default trigger button styling entirely. */
	triggerClassName?: string;
	/** Controlled open state (optional); pair with onOpenChange. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	// Keep the latest callback in a ref so the outside-click effect below
	// doesn't rebind listeners when the parent passes an inline arrow.
	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;

	// Controlled mode: parent closes the menu by flipping `open` to false.
	useEffect(() => {
		if (open === false) setPos(null);
	}, [open]);

	useEffect(() => {
		if (!pos) return;
		const close = () => {
			setPos(null);
			onOpenChangeRef.current?.(false);
		};
		const onDown = (e: MouseEvent) => {
			// Clicks on the trigger (inside wrapRef) fall through to its onClick,
			// which toggles the menu closed — same as the sidebar workspace menu.
			if (!wrapRef.current?.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [pos]);

	return (
		<div ref={wrapRef} className="relative inline-flex">
			<button
				type="button"
				disabled={disabled}
				title={title}
				onClick={(e) => {
					e.stopPropagation();
					const rect = e.currentTarget.getBoundingClientRect();
					// Open below the button, right-aligned with it (like the other
					// dropdown menus in the app); flip above the button when there is
					// no room below so the menu stays attached to it instead of being
					// clamped far away.
					const estHeight = estimateMenuHeight(items);
					const below = rect.bottom + 4;
					const y =
						below + estHeight <= window.innerHeight - 8
							? below
							: Math.max(8, rect.top - estHeight - 4);
					setPos((p) => {
						const next = p ? null : { x: rect.right - CONTEXT_MENU_MIN_WIDTH, y };
						onOpenChange?.(next !== null);
						return next;
					});
				}}
				className={triggerClassName ?? "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"}
			>
				{icon ?? <EllipsisVertical className="h-3.5 w-3.5" />}
			</button>
			{pos && (
				<ContextMenu
					x={pos.x}
					y={pos.y}
					items={items}
					onDismiss={() => {
						setPos(null);
						onOpenChange?.(false);
					}}
				/>
			)}
		</div>
	);
}

/**
 * Custom dropdown styled to match the rest of the app (rounded-lg, accent
 * focus ring, popup with check mark on the selected option). Replaces native
 * `<select>` so the form controls in popovers/modals look consistent with the
 * Composer / ScheduleModePicker dropdowns instead of using the OS chrome.
 */
export interface SelectOption {
	value: string;
	label: string;
	hint?: string;
}

export function Select({
	value,
	options,
	onChange,
	placeholder,
	title,
	size = "md",
}: {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	placeholder?: string;
	title?: string;
	size?: "sm" | "md";
}) {
	const [open, setOpen] = useState(false);
	// Index of the keyboard-highlighted option while the popup is open.
	const [activeIndex, setActiveIndex] = useState(-1);
	const wrapRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

	// Keep the keyboard-highlighted option scrolled into view.
	useEffect(() => {
		if (!open || activeIndex < 0) return;
		const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [open, activeIndex]);

	const openMenu = () => {
		const selectedIdx = options.findIndex((o) => o.value === value);
		setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
		setOpen(true);
	};

	const handleTriggerKeyDown = (e: ReactKeyboardEvent) => {
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openMenu();
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setActiveIndex((i) => Math.min(i + 1, options.length - 1));
				break;
			case "ArrowUp":
				e.preventDefault();
				setActiveIndex((i) => Math.max(i - 1, 0));
				break;
			case "Home":
				e.preventDefault();
				setActiveIndex(0);
				break;
			case "End":
				e.preventDefault();
				setActiveIndex(options.length - 1);
				break;
			case "Enter":
			case " ": {
				e.preventDefault();
				const opt = options[activeIndex];
				if (opt) {
					onChange(opt.value);
					setOpen(false);
				}
				break;
			}
			case "Tab":
				setOpen(false);
				break;
		}
	};

	const current = options.find((o) => o.value === value);
	const heightClass = size === "sm" ? "h-8" : "h-9";
	const textClass = size === "sm" ? "text-xs" : "text-sm";

	return (
		<div ref={wrapRef} className="relative" title={title}>
			<button
				type="button"
				role="combobox"
				aria-expanded={open}
				aria-haspopup="listbox"
				onClick={() => (open ? setOpen(false) : openMenu())}
				onKeyDown={handleTriggerKeyDown}
				className={cn(
					"flex w-full items-center justify-between gap-2 rounded-lg border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
					heightClass,
					textClass,
					open
						? "border-accent bg-surface text-fg"
						: "border-border bg-surface text-fg hover:border-accent/40",
				)}
			>
				<span className={cn("truncate", !current && "text-muted")}>
					{current ? current.label : (placeholder ?? "—")}
				</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-muted transition-transform",
						open && "rotate-180 text-accent",
					)}
				/>
			</button>
			{open && (
				<div ref={listRef} role="listbox" className={cn("absolute left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg", Z.menu)}>
					{options.map((o, i) => {
						const selected = o.value === value;
						const highlighted = i === activeIndex;
						return (
							<button
								key={o.value}
								type="button"
								role="option"
								aria-selected={selected}
								onMouseEnter={() => setActiveIndex(i)}
								onClick={() => {
									onChange(o.value);
									setOpen(false);
								}}
								className={cn(
									"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
									textClass,
									selected
										? "bg-accent/10 text-fg"
										: highlighted
											? "bg-surface-2 text-fg"
											: "text-muted hover:bg-surface-2 hover:text-fg",
								)}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate">{o.label}</span>
									{o.hint && (
										<span className="block truncate text-[10px] text-muted">{o.hint}</span>
									)}
								</span>
								{selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------------- *
 * ConfirmHost — renders confirmDialog()/alertDialog() requests (lib/confirm)
 * as app-styled modals. Mount exactly once near the app root.
 * ------------------------------------------------------------------------- */

/** Mount once (e.g. in App). Renders the currently pending confirm request. */
export function ConfirmHost() {
	const { t } = useTranslation();
	const [req, setReq] = useState<ConfirmRequest | null>(null);
	// Queue further requests while one is open so none are dropped.
	const queueRef = useRef<ConfirmRequest[]>([]);

	useEffect(() => {
		setConfirmHostHandler((r) => {
			setReq((cur) => {
				if (cur) {
					queueRef.current.push(r);
					return cur;
				}
				return r;
			});
		});
		return () => {
			setConfirmHostHandler(null);
		};
	}, []);

	const settle = (ok: boolean) => {
		req?.resolve(ok);
		setReq(queueRef.current.shift() ?? null);
	};

	if (!req) return null;

	return (
		<Modal
			open
			onClose={() => settle(!!req.alert)}
			title={req.title ?? (req.alert ? t("common.notice") : t("common.confirm"))}
			size="sm"
			footer={
				<>
					{!req.alert && (
						<Button tone="neutral" variant="outline" size="sm" onClick={() => settle(false)}>
							{req.cancelLabel ?? t("common.cancel")}
						</Button>
					)}
					<Button
						tone={req.danger ? "danger" : "accent"}
						size="sm"
						onClick={() => settle(true)}
					>
						{req.confirmLabel ?? (req.alert ? t("common.continue") : t("common.confirm"))}
					</Button>
				</>
			}
		>
			<p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{req.message}</p>
		</Modal>
	);
}
