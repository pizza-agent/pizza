import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export {
	isTauri,
	isMac,
	hasMacTrafficLights,
	normalizePathForCompare,
	samePath,
	isMainChatCwd,
	isRemoteWorkspaceKey,
	MAIN_CHAT_CWD,
	REMOTE_WORKSPACE_PREFIX,
	pathBasename,
} from "./platform";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
