/**
 * ExtensionMenus — menus contributed by extensions via `pizza.registerMenu()`
 * rendered in the app sidebar. Each menu is a row that opens a dropdown; an
 * item either steers a slash command into the session (`command`, e.g.
 * "/pet feed") or invokes a desktop command (`uiCommand`, e.g.
 * "toggle_pet_window").
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Puzzle } from "lucide-react";
import { getExtensionMenus, sendCommandAwait, type ExtensionMenuItemWire, type ExtensionMenuWire } from "@/lib/transport";
import { MoreMenu, type ContextMenuItem } from "./ui";
import { isTauri } from "@/lib/utils";

function runItem(item: ExtensionMenuItemWire): void {
	if (item.uiCommand) {
		if (!isTauri()) return;
		void import("@tauri-apps/api/core")
			.then(({ invoke }) => invoke(item.uiCommand!))
			.catch(() => {});
		return;
	}
	if (item.command) {
		// Extension commands resolve in-process via facade.steer — no user
		// message is appended and a running turn is not interrupted.
		void sendCommandAwait({ type: "steer", message: item.command }).catch(() => {});
	}
}

function menuItems(menu: ExtensionMenuWire): ContextMenuItem[] {
	return menu.items.map((item) => ({
		icon: ChevronRight,
		label: item.value ? `${item.label}  ${item.value}` : item.label,
		hint: item.description,
		disabled: !item.command && !item.uiCommand,
		onClick: () => runItem(item),
	}));
}

export function ExtensionMenus() {
	const [menus, setMenus] = useState<ExtensionMenuWire[]>([]);
	const [openId, setOpenId] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void getExtensionMenus().then(setMenus).catch(() => {});
	}, []);

	useEffect(refresh, [refresh]);

	if (menus.length === 0) return null;

	return (
		<div className="border-t border-border px-3 pt-2 pb-1">
			{menus.map((menu) => (
				<MoreMenu
					key={menu.id}
					open={openId === menu.id}
					onOpenChange={(open) => {
						setOpenId(open ? menu.id : null);
						if (open) refresh();
					}}
					items={menuItems(menu)}
					triggerClassName="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2/60"
					icon={
						<>
							<Puzzle className="h-4 w-4 shrink-0 text-muted" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] font-medium text-fg/90">{menu.label}</span>
								{menu.description && (
									<span className="block truncate text-[11px] text-muted">{menu.description}</span>
								)}
							</span>
							<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
						</>
					}
				/>
			))}
		</div>
	);
}
