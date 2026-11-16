/**
 * Extract a file mutation's unified diff from the execution details.
 *
 * `_edit` stores its diff under the CLI command's own details
 * (`details.command.details.diff`) rather than in `file_mutations`. Keeping
 * this helper standalone makes the shape easy to test without running a reactor.
 */
export function fileMutationDiff(details: unknown, path: string): string | undefined {
	const command = (details as {
		command?: { args?: { path?: unknown }; details?: { diff?: unknown } };
	})?.command;
	if (command?.args?.path !== path) return undefined;
	return typeof command.details?.diff === "string" ? command.details.diff : undefined;
}
