/**
 * Command-line redactors applied before a cli call is classified, approved,
 * or written to the event log.
 *
 * Redactors must be idempotent. They stash anything they remove so the
 * command can still execute, and they must not put the removed text back
 * into the string that gets logged.
 */

export type CommandRedactor = (command: string) => string;

const redactors: CommandRedactor[] = [];

/** Register a redactor. Returns an unregister function. */
export function registerCommandRedactor(redactor: CommandRedactor): () => void {
	redactors.push(redactor);
	return () => {
		const index = redactors.indexOf(redactor);
		if (index >= 0) redactors.splice(index, 1);
	};
}

/** Apply every registered redactor. Unknown commands pass through unchanged. */
export function redactCommandForLog(command: string): string {
	let current = command;
	for (const redactor of redactors) current = redactor(current);
	return current;
}
