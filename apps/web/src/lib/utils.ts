import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { isTauri, isMac, hasMacTrafficLights, normalizePathForCompare, samePath, isMainChatCwd, MAIN_CHAT_CWD, pathBasename } from "./platform";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}