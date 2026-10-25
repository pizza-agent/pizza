/**
 * PetMenu — the pet's right-click menu, shared by the in-app pet and the
 * floating pet window. Callers build the items; plugin-contributed pet
 * actions (`pizza.pet.registerAction`) are appended by `petPluginItems`.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Puzzle } from "lucide-react";
import { createPortal } from "react-dom";
import { runPetPluginAction, type PetAction } from "@/lib/pet";
import "./pet-menu.css";

export interface PetMenuItem {
	id: string;
	label: string;
	icon?: ReactNode;
	danger?: boolean;
	/** Draw a separator above this item. */
	separator?: boolean;
	onSelect: () => void;
}

export function petPluginItems(actions: PetAction[]): PetMenuItem[] {
	return actions.map((action, i) => ({
		id: `plugin:${action.id}`,
		label: action.label,
		icon: <Puzzle strokeWidth={1.8} />,
		separator: i === 0,
		onSelect: () => { void runPetPluginAction(action).catch((e) => console.error("pet action failed:", e)); },
	}));
}

export function PetMenu({ x, y, title, level, items, onDismiss }: {
	x: number;
	y: number;
	title?: string;
	level?: number;
	items: PetMenuItem[];
	onDismiss: () => void;
}) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ left: x, top: y, origin: "top left" });

	// Open toward the roomier side of the cursor, then clamp into the window
	// (the floating pet window is tiny). Measured after mount.
	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		const m = 4;
		const flipX = x + width + m > window.innerWidth;
		const flipY = y + height + m > window.innerHeight;
		const left = Math.max(m, Math.min(flipX ? x - width : x, window.innerWidth - width - m));
		const top = Math.max(m, Math.min(flipY ? y - height : y, window.innerHeight - height - m));
		setPos({ left, top, origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}` });
		el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
	}, [x, y]);

	useEffect(() => {
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
		const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) onDismiss(); };
		window.addEventListener("mousedown", onDismiss);
		window.addEventListener("keydown", key);
		window.addEventListener("blur", onDismiss);
		window.addEventListener("resize", onDismiss);
		window.addEventListener("scroll", scroll, true);
		return () => {
			window.removeEventListener("mousedown", onDismiss);
			window.removeEventListener("keydown", key);
			window.removeEventListener("blur", onDismiss);
			window.removeEventListener("resize", onDismiss);
			window.removeEventListener("scroll", scroll, true);
		};
	}, [onDismiss]);

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
		const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === "ArrowDown" ? i + 1 : i - 1 + buttons.length;
		buttons[next % buttons.length]?.focus();
	};

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label={title ?? "Pet"}
			className="pet-menu"
			data-nodrag
			style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={onKeyDown}
		>
			{title && (
				<>
					<div className="pet-menu__header">
						<span>{title}</span>
						{level != null && <span className="pet-menu__level">Lv.{level}</span>}
					</div>
					<div className="pet-menu__sep" role="separator" />
				</>
			)}
			{items.map((item) => (
				<Fragment key={item.id}>
					{item.separator && <div className="pet-menu__sep" role="separator" />}
					<button
						type="button"
						role="menuitem"
						className={item.danger ? "pet-menu__item pet-menu__item--danger" : "pet-menu__item"}
						title={item.label}
						onClick={() => { onDismiss(); item.onSelect(); }}
					>
						{item.icon}
						{item.label}
					</button>
				</Fragment>
			))}
		</div>,
		document.body,
	);
}
