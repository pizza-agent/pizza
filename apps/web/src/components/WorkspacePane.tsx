import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PanelRight, PanelBottom } from "lucide-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";
import { ResizeHandle } from "./ResizeHandle";
import RightDock, { type RightDockTab } from "./RightDock";
import { MainAgentPet } from "./MainAgentPet";
import { useMainAgentProfile } from "@/lib/main-agent-profile";
import BottomDock from "./BottomDock";

const RIGHT_MIN = 320;
const RIGHT_MAX_RATIO = 0.6;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 640;

/**
 * Wraps the routed main view (Chat) with a collapsible right dock
 * (History / Timeline) and a collapsible bottom dock (Terminal), plus the
 * top-right toggle buttons. All docks are scoped to the active workspace.
 */
export default function WorkspacePane({
	workspace,
	ptyPort,
	children,
	isMain = false,
	running = false,
	connected = false,
	sidebarCollapsed = false,
}: {
	workspace?: string | null;
	ptyPort?: number;
	children: ReactNode;
	isMain?: boolean;
	running?: boolean;
	connected?: boolean;
	sidebarCollapsed?: boolean;
}) {
	const { t } = useTranslation();
	const [workspaceRightOpen, setWorkspaceRightOpen] = usePersistedState<boolean>("right-dock-open", true);
	const [mainRightOpen, setMainRightOpen] = usePersistedState<boolean>("main-right-dock-open", false);
	const [mainTab, setMainTab] = usePersistedState<RightDockTab>("main-right-dock-tab", "agent");
	const rightOpen = isMain ? mainRightOpen : workspaceRightOpen;
	const setRightOpen = isMain ? setMainRightOpen : setWorkspaceRightOpen;
	const mainAgent = useMainAgentProfile(isMain, workspace, running, connected);
	const toggle = useRef<HTMLButtonElement>(null);
	const [rightWidth, setRightWidth] = usePersistedState<number>("right-dock-width", 420);
	const [bottomOpen, setBottomOpen] = usePersistedState<boolean>("bottom-dock-open", false);
	const [bottomHeight, setBottomHeight] = usePersistedState<number>("bottom-dock-height", 240);

	const closeDock = useCallback(() => {
		setRightOpen(false);
		requestAnimationFrame(() => toggle.current?.focus());
	}, [setRightOpen]);
	const openAgent = useCallback(() => {
		if (mainRightOpen && mainTab === "agent") closeDock();
		else { setMainTab("agent"); setMainRightOpen(true); }
	}, [mainRightOpen, mainTab, closeDock, setMainTab, setMainRightOpen]);
	const showAgent = useCallback(() => { setMainTab("agent"); setMainRightOpen(true); }, [setMainTab, setMainRightOpen]);
	useEffect(() => {
		window.addEventListener("pizza:open-agent-profile", showAgent);
		return () => window.removeEventListener("pizza:open-agent-profile", showAgent);
	}, [showAgent]);

	const clampRight = useCallback((next: number) => {
		const max = Math.max(RIGHT_MIN, window.innerWidth * RIGHT_MAX_RATIO);
		setRightWidth(Math.min(max, Math.max(RIGHT_MIN, next)));
	}, [setRightWidth]);

	const clampBottom = useCallback((next: number) => {
		setBottomHeight(Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, next)));
	}, [setBottomHeight]);

	// Both controls travel together into the panel header when it is open.
	const dockControls = <>
		{!isMain && <button
			type="button"
			aria-label={t("terminal.toggle")}
			aria-expanded={bottomOpen}
			onClick={() => setBottomOpen((value) => !value)}
			className={cn(
				"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
				bottomOpen ? "text-accent" : "text-muted/60 hover:text-muted",
			)}
			title={t("terminal.toggle")}
		>
			<PanelBottom className="h-4 w-4" />
		</button>}
		<button
			ref={toggle}
			type="button"
			aria-label={t(rightOpen ? "dock.closeRight" : "dock.openRight")}
			aria-expanded={rightOpen}
			aria-controls={rightOpen ? "right-dock-content" : undefined}
			onClick={() => {
				setRightOpen((value) => !value);
				requestAnimationFrame(() => toggle.current?.focus());
			}}
			className={cn(
				"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
				rightOpen ? "text-accent" : "text-muted/60 hover:text-muted",
			)}
			title={t(rightOpen ? "dock.closeRight" : "dock.openRight")}
		>
			<PanelRight className="h-4 w-4" />
		</button>
	</>;

	return (
		<div className="relative flex h-full flex-col">
			{/* Main row: routed view + right dock. */}
			<div className="relative flex min-h-0 flex-1">
				{/* An open right dock owns both controls; otherwise they stay over chat. */}
				<div className="relative min-w-0 flex-1 overflow-hidden">
					{!rightOpen && <div className={cn("absolute right-2 top-2 flex items-center gap-1", Z.chrome)}>{dockControls}</div>}
					{children}
					{isMain && <MainAgentPet profile={mainAgent.profile} pet={mainAgent.pet} running={running} onOpen={openAgent} onShowProfile={showAgent} topInset={sidebarCollapsed ? 8 : 0} />}
				</div>
				{rightOpen && (
					<>
						<ResizeHandle
							orientation="vertical"
							subtle
							invert
							getSize={() => rightWidth}
							onResize={clampRight}
						/>
						<div className="shrink-0" style={{ width: rightWidth }}>
							<RightDock key={isMain ? "main" : workspace} workspace={workspace} isMain={isMain} selectedTab={isMain ? mainTab : undefined} onTabChange={isMain ? setMainTab : undefined} mainAgent={mainAgent} running={running} connected={connected} headerAction={dockControls} />
						</div>
					</>
				)}
			</div>

			{/* Bottom row: terminal dock (hidden when closed). */}
			{!isMain && bottomOpen && (
				<>
					<ResizeHandle
						orientation="horizontal"
						subtle
						invert
						getSize={() => bottomHeight}
						onResize={clampBottom}
					/>
					<div className="shrink-0" style={{ height: bottomHeight }}>
						<BottomDock workspace={workspace} ptyPort={ptyPort} onCollapse={() => setBottomOpen(false)} />
					</div>
				</>
			)}
		</div>
	);
}
