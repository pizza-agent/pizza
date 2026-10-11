/**
 * `pizza auth` subcommand — account (OAuth) and API-key login.
 *
 *   pizza auth list                       Show available login options (both categories).
 *   pizza auth login --provider X         Run the OAuth flow (TUI or JSONL host mode).
 *     [--mode tui|jsonl]
 *   pizza auth login-api-key --provider X Save a manually entered API key.
 *     [--key <key>]
 *   pizza auth logout --provider X        Remove stored credentials for a provider.
 *
 * JSONL host mode (`--mode jsonl`) is for GUI hosts (desktop, web): each
 * pi-ai AuthPrompt/AuthEvent is written to stdout as one JSON line; answers
 * arrive on stdin as JSON lines ({"answer": "..."}); the final line is
 * {"ok":true} or {"ok":false,"error":"..."}.
 */

import type { AuthInteraction } from "@earendil-works/pi-ai/compat";
import chalk from "chalk";
import { getAgentDir } from "./config.js";
import { AuthStorage } from "./core/auth/auth-storage.js";
import { getApiKeyOptions, getOAuthFlows } from "./core/auth/oauth.js";

function printHelp(): void {
	console.log(`pizza auth - manage provider authentication

Usage:
  pizza auth list [--json]              List login options (account + API key)
  pizza auth login --provider <id>       Sign in with an account (OAuth)
      [--mode tui|jsonl]                 tui: terminal prompts (default)
                                         jsonl: JSONL host protocol on stdio
  pizza auth login-api-key --provider <id> [--key <key>]
                                         Sign in with an API key
  pizza auth logout --provider <id>      Sign out of a provider
`);
}

function parseArgs(args: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
	const flags: Record<string, string | boolean> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			rest.push(arg);
		}
	}
	return { flags, rest };
}

function createAuthStorage(): AuthStorage {
	return AuthStorage.create(`${getAgentDir()}/auth.json`);
}

/** Read newline-delimited JSON answers from stdin. */
function openJsonlAnswerStream(): { next: () => Promise<string> } {
	let buffer = "";
	const pending: string[] = [];
	const waiters: ((value: string) => void)[] = [];

	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				const waiter = waiters.shift();
				if (waiter) waiter(line);
				else pending.push(line);
			}
			nl = buffer.indexOf("\n");
		}
	});
	process.stdin.resume();

	return {
		next: () =>
			new Promise<string>((resolve) => {
				const buffered = pending.shift();
				if (buffered !== undefined) resolve(buffered);
				else waiters.push(resolve);
			}),
	};
}

/** Build an AuthInteraction that speaks the JSONL host protocol. */
function jsonlInteraction(signal: AbortSignal): AuthInteraction {
	const answers = openJsonlAnswerStream();
	const emit = (obj: unknown) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	return {
		signal,
		async prompt(prompt) {
			emit({ type: "prompt", prompt });
			const line = await answers.next();
			try {
				const parsed = JSON.parse(line) as { answer?: string };
				if (typeof parsed.answer !== "string") throw new Error("missing answer");
				return parsed.answer;
			} catch {
				throw new Error("Invalid JSONL answer on stdin");
			}
		},
		notify(event) {
			emit({ type: "event", event });
		},
	};
}

/** Terminal AuthInteraction (plain readline-free prompts via stdin lines). */
function tuiInteraction(signal: AbortSignal): AuthInteraction {
	const answers = openJsonlAnswerStream();
	const emit = (msg: string) => {
		process.stdout.write(`${msg}\n`);
	};
	return {
		signal,
		async prompt(prompt) {
			switch (prompt.type) {
				case "select": {
					emit(prompt.message);
					prompt.options.forEach((o) => emit(`  ${o.id}: ${o.label}${o.description ? ` — ${o.description}` : ""}`));
					break;
				}
				default:
					emit(prompt.message);
					break;
			}
			const answer = (await answers.next()).trim();
			if (!answer && prompt.type !== "text") {
				throw new Error("Login cancelled (empty input)");
			}
			return answer;
		},
		notify(event) {
			if (event.type === "auth_url") {
				emit(`Open this URL to continue: ${event.url}`);
				if (event.instructions) emit(event.instructions);
			} else if (event.type === "device_code") {
				emit(`Enter code ${event.userCode} at ${event.verificationUri}`);
			} else if (event.message) {
				emit(event.message);
			}
		},
	};
}

export async function handleAuthCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "auth") return false;

	const sub = args[1];
	const { flags } = parseArgs(args.slice(2));
	const providerId = typeof flags.provider === "string" ? flags.provider : undefined;
	const authStorage = createAuthStorage();

	switch (sub) {
		case "list": {
			const flows = getOAuthFlows();
			const keyOptions = getApiKeyOptions();
			if (flags.json === true) {
				process.stdout.write(
					`${JSON.stringify({
						account: flows.map((f) => ({ id: f.id, name: f.name })),
						apiKey: keyOptions.map((o) => ({ id: o.id, name: o.name })),
					})}\n`,
				);
				return true;
			}
			console.log(chalk.bold("Sign in with an account:"));
			for (const flow of flows) {
				const cred = authStorage.get(flow.id);
				const status = cred?.type === "oauth" ? chalk.green(" ✓ signed in") : "";
				console.log(`  ${flow.id.padEnd(16)} ${flow.name}${status}`);
			}
			console.log(chalk.bold("\nSign in with an API key:"));
			for (const option of getApiKeyOptions()) {
				const cred = authStorage.get(option.id);
				const status = cred?.type === "api_key" ? chalk.green(" ✓ key set") : "";
				console.log(`  ${option.id.padEnd(16)} ${option.name}${status}`);
			}
			return true;
		}

		case "login": {
			if (!providerId) {
				console.error(chalk.red('Missing --provider. Run "pizza auth list" for ids.'));
				process.exit(1);
			}
			const flow = getOAuthFlows().find((f) => f.id === providerId);
			if (!flow) {
				console.error(chalk.red(`Provider has no account (OAuth) login: ${providerId}`));
				process.exit(1);
			}
			const mode = flags.mode === "jsonl" ? "jsonl" : "tui";
			const interaction = mode === "jsonl" ? jsonlInteraction(new AbortController().signal) : tuiInteraction(new AbortController().signal);
			try {
				await authStorage.login(providerId, interaction);
				if (mode === "jsonl") process.stdout.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
				else console.log(chalk.green(`Signed in to ${flow.name}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (mode === "jsonl") process.stdout.write(`${JSON.stringify({ type: "done", ok: false, error: message })}\n`);
				else console.error(chalk.red(`Login failed: ${message}`));
				process.exitCode = 1;
			}
			return true;
		}

		case "login-api-key": {
			if (!providerId) {
				console.error(chalk.red('Missing --provider. Run "pizza auth list" for ids.'));
				process.exit(1);
			}
			const key = typeof flags.key === "string" ? flags.key : undefined;
			if (key) {
				authStorage.set(providerId, { type: "api_key", key });
				console.log(chalk.green(`API key saved for ${providerId}`));
				return true;
			}
			const interaction = tuiInteraction(new AbortController().signal);
			try {
				await authStorage.loginApiKey(providerId, interaction);
				console.log(chalk.green(`API key saved for ${providerId}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`API key login failed: ${message}`));
				process.exitCode = 1;
			}
			return true;
		}

		case "logout": {
			if (!providerId) {
				console.error(chalk.red("Missing --provider."));
				process.exit(1);
			}
			authStorage.logout(providerId);
			console.log(chalk.green(`Signed out of ${providerId}`));
			return true;
		}

		case "-h":
		case "--help":
		case undefined:
			printHelp();
			return true;
		default:
			console.error(chalk.red(`Unknown auth subcommand: ${sub}`));
			printHelp();
			process.exit(1);
	}
}
