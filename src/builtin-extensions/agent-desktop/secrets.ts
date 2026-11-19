/**
 * Short-lived stash for text that must not be written into Pizza's event log
 * (typed text, clipboard writes). The logged command keeps a numeric handle.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;

interface SecretEntry {
	text: string;
	at: number;
}

const secrets = new Map<number, SecretEntry>();
let nextId = 1;

function sweep(now: number): void {
	for (const [id, entry] of secrets) {
		if (now - entry.at > TTL_MS) secrets.delete(id);
	}
	while (secrets.size > MAX_ENTRIES) {
		const oldest = secrets.keys().next().value;
		if (oldest === undefined) break;
		secrets.delete(oldest);
	}
}

export function stashSecret(text: string): number {
	const now = Date.now();
	sweep(now);
	const id = nextId++;
	secrets.set(id, { text, at: now });
	return id;
}

export function peekSecret(id: number): string | undefined {
	const entry = secrets.get(id);
	if (!entry) return undefined;
	if (Date.now() - entry.at > TTL_MS) {
		secrets.delete(id);
		return undefined;
	}
	return entry.text;
}

export function resetDesktopSecretsForTests(): void {
	secrets.clear();
	nextId = 1;
}
