/**
 * Slash-command model for the composer `/` menu — mirrors the TUI's four
 * sources: desktop builtin actions (handled locally, like the TUI's builtin
 * selectors), skills, prompt templates and extension commands (sent through
 * prompt for the agent to interpret).
 */

export type SlashCategory = "builtin" | "skill" | "prompt" | "extension";

export interface SlashItem {
	category: SlashCategory;
	/** Command name without the leading slash (skills use "skill:<name>"). */
	name: string;
	description?: string;
	/** Secondary hint — argument hint for prompt templates. */
	hint?: string;
}

/** Display order of categories in the `/` popup. */
export const SLASH_CATEGORY_RANK: Record<SlashCategory, number> = {
	builtin: 0,
	skill: 1,
	prompt: 2,
	extension: 3,
};

/** Builtin commands with a desktop equivalent. Arg-taking commands are
 *  inserted into the input for editing; the rest execute on selection. */
export type BuiltinCommandName = "settings" | "model" | "compact" | "export" | "new";

export interface BuiltinCommandDef {
	name: BuiltinCommandName;
	/** True when trailing args are meaningful (insert into input instead of executing). */
	takesArgs: boolean;
}

export const DESKTOP_BUILTIN_COMMANDS: readonly BuiltinCommandDef[] = [
	{ name: "settings", takesArgs: false },
	{ name: "model", takesArgs: true },
	{ name: "compact", takesArgs: true },
	{ name: "export", takesArgs: true },
	{ name: "new", takesArgs: false },
];

/** Parse `/name args...` from composer input. Null when the text is not a
 *  slash command (does not start with "/" or has no command name). */
export function parseSlashInput(text: string): { name: string; args: string } | null {
	if (!text.startsWith("/")) return null;
	const spaceIndex = text.indexOf(" ");
	const name = (spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)).trim();
	if (!name) return null;
	return { name, args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim() };
}

/** True when the composer input is still in "typing the command name" state:
 *  starts with "/" and the cursor has not moved past the first whitespace. */
export function slashQueryAt(value: string, cursorPos: number): string | null {
	if (!value.startsWith("/") || cursorPos <= 0) return null;
	const before = value.slice(0, cursorPos);
	if (!/^\/\S*$/.test(before)) return null;
	return before.slice(1);
}

const SLASH_MAX_QUERY = 64;

/** Filter + rank slash items against the typed query. Categories keep their
 *  rank order; within a block, prefix matches beat substring matches. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
	const q = query.trim().toLowerCase();
	if (q.length > SLASH_MAX_QUERY) return [];
	if (!q) return items;
	const scored: { item: SlashItem; score: number }[] = [];
	for (const item of items) {
		const name = item.name.toLowerCase();
		let score = 0;
		if (name.startsWith(q)) score = 3;
		else if (name.includes(q)) score = 2;
		else if (item.description?.toLowerCase().includes(q)) score = 1;
		if (score > 0) scored.push({ item, score });
	}
	scored.sort(
		(a, b) =>
			SLASH_CATEGORY_RANK[a.item.category] - SLASH_CATEGORY_RANK[b.item.category] ||
			b.score - a.score,
	);
	return scored.map((s) => s.item);
}
