/**
 * The cli tool's command table: built-in, SDK and extension `_xxx` commands
 * in one lookup. Commands not found here fall through to the shell (when the
 * session enables it).
 */

import type { CliCommandDefinition, RegisteredCliCommand } from "../extensions/types.js";
import { BUILTIN_COMMANDS } from "./builtin-commands.js";

export type CliCommandSource = "builtin" | "extension" | "sdk";

export interface CliCommandEntry {
	spec: CliCommandDefinition;
	source: CliCommandSource;
}

const COMMAND_NAME_RE = /^_[a-z][a-z0-9_-]*$/;

/**
 * Validate a non-built-in command definition: "_" + lowercase identifier,
 * no collision with a built-in, and an argument parser.
 */
export function validateCliCommand(command: CliCommandDefinition): void {
	if (!COMMAND_NAME_RE.test(command.name)) {
		throw new Error(
			`Invalid cli command name: ${command.name}. Must be an underscore token like "_computer_use" (lowercase letters, digits, - or _).`,
		);
	}
	if ((BUILTIN_COMMANDS as readonly string[]).includes(command.name)) {
		throw new Error(`cli command name ${command.name} collides with a built-in command.`);
	}
	if (!command.parseArguments && !command.parameters) {
		throw new Error(`cli command ${command.name} needs parseArguments or parameters.`);
	}
}

export interface CommandRegistryDeps {
	builtins: CliCommandDefinition[];
	sdk?: CliCommandDefinition[];
	/** Read lazily so extension commands registered mid-session are picked up. */
	extensions?: () => RegisteredCliCommand[];
	/** Called once per name when an extension command is shadowed by an SDK command. */
	onConflict?: (command: RegisteredCliCommand, message: string) => void;
}

export class CommandRegistry {
	private readonly reportedConflicts = new Set<string>();

	constructor(private readonly deps: CommandRegistryDeps) {}

	/** Every registered command; priority builtin > sdk > extension (first wins). */
	entries(): CliCommandEntry[] {
		const byName = new Map<string, CliCommandEntry>();
		for (const spec of this.deps.builtins) byName.set(spec.name, { spec, source: "builtin" });
		for (const spec of this.deps.sdk ?? []) {
			if (!byName.has(spec.name)) byName.set(spec.name, { spec, source: "sdk" });
		}
		for (const spec of this.deps.extensions?.() ?? []) {
			const existing = byName.get(spec.name);
			if (!existing) {
				byName.set(spec.name, { spec, source: "extension" });
			} else if (existing.source === "sdk" && !this.reportedConflicts.has(spec.name)) {
				this.reportedConflicts.add(spec.name);
				this.deps.onConflict?.(
					spec,
					`Extension cli command ${spec.name} (${spec.sourceInfo.path}) is ignored: the name is already registered by the SDK caller.`,
				);
			}
		}
		return [...byName.values()];
	}

	get(name: string): CliCommandEntry | undefined {
		return this.entries().find((entry) => entry.spec.name === name);
	}

	/** Commands whose environment check passes (the ones shown to the model). */
	available(): CliCommandEntry[] {
		return this.entries().filter((entry) => entry.spec.isAvailable?.() ?? true);
	}

	names(): string[] {
		return this.entries().map((entry) => entry.spec.name);
	}
}
