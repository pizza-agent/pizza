/**
 * Built-in extension ids that stay unloaded until the user enables them.
 *
 * Kept in this file so settings can see the opt-in list without importing the
 * extension implementations (that import would cycle through SettingsManager).
 */
export const OPT_IN_BUILTIN_EXTENSION_IDS: readonly string[] = [];

export function isOptInBuiltinExtension(id: string): boolean {
	return (OPT_IN_BUILTIN_EXTENSION_IDS as readonly string[]).includes(id);
}
