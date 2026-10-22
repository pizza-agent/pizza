/**
 * One-way provider configuration mirroring for remote Pizza workspaces.
 *
 * The desktop environment remains the editing authority. The remote process
 * validates the full envelope, replaces only provider-owned configuration,
 * and rolls every touched file back when any write or refresh step fails.
 */

import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";

export const PROVIDER_PROVISIONING_SCHEMA_VERSION = 1 as const;
export const PROVIDER_CREDENTIALS_SCHEMA_VERSION = 1 as const;

const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export type ProviderProvisioningStatus =
	| "applied"
	| "already_applied"
	| "failed"
	| "rollback_failed";

export type ProviderProvisioningErrorCode =
	| "invalid_envelope"
	| "input_too_large"
	| "target_read_failed"
	| "target_write_failed"
	| "rollback_failed";

export interface ProviderProvisioningResult {
	syncId: string;
	status: ProviderProvisioningStatus;
	personalProviderCount: number;
	credentialCount: number;
	errorCode?: ProviderProvisioningErrorCode;
	errorMessage?: string;
	rolledBack: boolean;
}

export interface ProviderProvisioningEnvelope {
	schemaVersion: typeof PROVIDER_PROVISIONING_SCHEMA_VERSION;
	syncId: string;
	source: {
		modelsRevision: string;
		settingsRevision: string;
		credentialsRevision: string;
	};
	models: {
		providers: Record<string, Record<string, unknown>>;
	};
	settings: {
		defaultProvider: string | null;
		defaultModel: string | null;
		defaultThinkingLevel: string | null;
	};
	credentials: {
		schemaVersion: typeof PROVIDER_CREDENTIALS_SCHEMA_VERSION;
		entries: Record<string, Record<string, unknown>>;
	};
}

interface ApplyOptions {
	agentDir?: string;
	/** Test seam used to force a failure after earlier domains were written. */
	atomicWrite?: typeof atomicWriteFile;
}

type JsonObject = Record<string, unknown>;

interface FileSnapshot {
	exists: boolean;
	bytes?: Buffer;
	mode?: number;
}

interface PreparedTarget {
	authPath: string;
	modelsPath: string;
	settingsPath: string;
	authValue: JsonObject;
	modelsValue: JsonObject;
	settingsValue: JsonObject;
}

class EnvelopeValidationError extends Error {}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: JsonObject, expected: readonly string[], path: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (!isDeepStrictEqual(actual, wanted)) {
		throw new EnvelopeValidationError(
			`${path} must contain exactly: ${expected.join(", ")}`,
		);
	}
}

function requireObject(value: unknown, path: string): JsonObject {
	if (!isObject(value)) {
		throw new EnvelopeValidationError(`${path} must be an object`);
	}
	return value;
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new EnvelopeValidationError(`${path} must be a non-empty string`);
	}
	if (value.length > 512 || value.includes("\0")) {
		throw new EnvelopeValidationError(`${path} contains an invalid value`);
	}
	return value;
}

function validateProviderId(value: string, path: string): void {
	if (value.length === 0 || value.length > 256 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new EnvelopeValidationError(`${path} is not a valid provider id`);
	}
}

function validateCredential(value: unknown, path: string): Record<string, unknown> {
	const credential = requireObject(value, path);
	const type = requireString(credential.type, `${path}.type`);
	if (type === "api_key") {
		requireString(credential.key, `${path}.key`);
		return credential;
	}
	if (type === "oauth") {
		// Pizza's OAuth records evolve with providers. The access token is the
		// stable secret-bearing allowlist anchor; all other fields stay opaque.
		requireString(credential.access, `${path}.access`);
		return credential;
	}
	throw new EnvelopeValidationError(`${path}.type is not in the credential allowlist`);
}

export function parseProviderProvisioningEnvelope(value: unknown): ProviderProvisioningEnvelope {
	const root = requireObject(value, "envelope");
	assertExactKeys(
		root,
		["schemaVersion", "syncId", "source", "models", "settings", "credentials"],
		"envelope",
	);
	if (root.schemaVersion !== PROVIDER_PROVISIONING_SCHEMA_VERSION) {
		throw new EnvelopeValidationError(
			`envelope.schemaVersion must be ${PROVIDER_PROVISIONING_SCHEMA_VERSION}`,
		);
	}
	const syncId = requireString(root.syncId, "envelope.syncId");

	const source = requireObject(root.source, "envelope.source");
	assertExactKeys(
		source,
		["modelsRevision", "settingsRevision", "credentialsRevision"],
		"envelope.source",
	);
	const modelsRevision = requireString(source.modelsRevision, "envelope.source.modelsRevision");
	const settingsRevision = requireString(source.settingsRevision, "envelope.source.settingsRevision");
	const credentialsRevision = requireString(
		source.credentialsRevision,
		"envelope.source.credentialsRevision",
	);

	const models = requireObject(root.models, "envelope.models");
	assertExactKeys(models, ["providers"], "envelope.models");
	const rawProviders = requireObject(models.providers, "envelope.models.providers");
	const providers: Record<string, Record<string, unknown>> = {};
	for (const [providerId, providerValue] of Object.entries(rawProviders)) {
		validateProviderId(providerId, "envelope.models.providers");
		providers[providerId] = requireObject(
			providerValue,
			`envelope.models.providers.${providerId}`,
		);
	}

	const settings = requireObject(root.settings, "envelope.settings");
	assertExactKeys(
		settings,
		["defaultProvider", "defaultModel", "defaultThinkingLevel"],
		"envelope.settings",
	);
	const narrowSetting = (field: string): string | null => {
		const value = settings[field];
		if (value === null) return null;
		return requireString(value, `envelope.settings.${field}`, true);
	};

	const credentials = requireObject(root.credentials, "envelope.credentials");
	assertExactKeys(credentials, ["schemaVersion", "entries"], "envelope.credentials");
	if (credentials.schemaVersion !== PROVIDER_CREDENTIALS_SCHEMA_VERSION) {
		throw new EnvelopeValidationError(
			`envelope.credentials.schemaVersion must be ${PROVIDER_CREDENTIALS_SCHEMA_VERSION}`,
		);
	}
	const rawEntries = requireObject(credentials.entries, "envelope.credentials.entries");
	const entries: Record<string, Record<string, unknown>> = {};
	for (const [providerId, credentialValue] of Object.entries(rawEntries)) {
		validateProviderId(providerId, "envelope.credentials.entries");
		entries[providerId] = validateCredential(
			credentialValue,
			`envelope.credentials.entries.${providerId}`,
		);
	}

	return {
		schemaVersion: PROVIDER_PROVISIONING_SCHEMA_VERSION,
		syncId,
		source: { modelsRevision, settingsRevision, credentialsRevision },
		models: { providers },
		settings: {
			defaultProvider: narrowSetting("defaultProvider"),
			defaultModel: narrowSetting("defaultModel"),
			defaultThinkingLevel: narrowSetting("defaultThinkingLevel"),
		},
		credentials: {
			schemaVersion: PROVIDER_CREDENTIALS_SCHEMA_VERSION,
			entries,
		},
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function readJsonObject(path: string, allowMissing: boolean): Promise<JsonObject> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (allowMissing && isObject(error) && error.code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${path} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(parsed)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return parsed;
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
	try {
		const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
		return { exists: true, bytes, mode: metadata.mode & 0o777 };
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return { exists: false };
		throw error;
	}
}

async function atomicWriteFile(path: string, bytes: Buffer, mode = FILE_MODE): Promise<void> {
	const tempPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(tempPath, bytes, { mode });
	await chmod(tempPath, mode);
	try {
		await rename(tempPath, path);
	} catch (error) {
		// Windows does not consistently replace an existing destination with
		// rename. The provisioning lock still prevents concurrent Pizza writes.
		if (isObject(error) && (error.code === "EEXIST" || error.code === "EPERM")) {
			await rm(path, { force: true });
			await rename(tempPath, path);
		} else {
			await rm(tempPath, { force: true });
			throw error;
		}
	}
	await chmod(path, mode);
}

async function restoreSnapshot(path: string, snapshot: FileSnapshot): Promise<void> {
	if (snapshot.exists && snapshot.bytes) {
		await atomicWriteFile(path, snapshot.bytes, snapshot.mode ?? FILE_MODE);
		return;
	}
	await rm(path, { force: true });
}

async function ensureLockTarget(path: string, fallback: string): Promise<void> {
	if (await pathExists(path)) return;
	try {
		await writeFile(path, fallback, { mode: FILE_MODE, flag: "wx" });
		await chmod(path, FILE_MODE);
	} catch (error) {
		if (!(isObject(error) && error.code === "EEXIST")) throw error;
	}
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
	return await lockfile.lock(path, {
		realpath: false,
		retries: {
			retries: 12,
			factor: 1.5,
			minTimeout: 50,
			maxTimeout: 2_000,
			randomize: true,
		},
		stale: 30_000,
	});
}

function encodeJson(value: JsonObject): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildTargetValues(
	envelope: ProviderProvisioningEnvelope,
	currentModels: JsonObject,
	currentSettings: JsonObject,
): Pick<PreparedTarget, "authValue" | "modelsValue" | "settingsValue"> {
	const modelsValue: JsonObject = {
		...currentModels,
		providers: envelope.models.providers,
	};
	const settingsValue: JsonObject = { ...currentSettings };
	for (const field of [
		"defaultProvider",
		"defaultModel",
		"defaultThinkingLevel",
	] as const) {
		const value = envelope.settings[field];
		if (value === null) {
			delete settingsValue[field];
		} else {
			settingsValue[field] = value;
		}
	}
	return {
		authValue: envelope.credentials.entries,
		modelsValue,
		settingsValue,
	};
}

function failedResult(
	syncId: string,
	errorCode: ProviderProvisioningErrorCode,
	errorMessage: string,
	rolledBack: boolean,
	status: ProviderProvisioningStatus = "failed",
	providerCount = 0,
	credentialCount = 0,
): ProviderProvisioningResult {
	return {
		syncId,
		status,
		personalProviderCount: providerCount,
		credentialCount,
		errorCode,
		errorMessage,
		rolledBack,
	};
}

export async function applyProviderProvisioningEnvelope(
	envelope: ProviderProvisioningEnvelope,
	options: ApplyOptions = {},
): Promise<ProviderProvisioningResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const writeAtomic = options.atomicWrite ?? atomicWriteFile;
	const authPath = join(agentDir, "auth.json");
	const modelsPath = join(agentDir, "models.json");
	const settingsPath = join(agentDir, "settings.json");
	const providerCount = Object.keys(envelope.models.providers).length;
	const credentialCount = Object.keys(envelope.credentials.entries).length;

	await mkdir(agentDir, { recursive: true, mode: DIRECTORY_MODE });
	if (process.platform !== "win32") {
		await chmod(agentDir, DIRECTORY_MODE);
	}

	const targets = [authPath, modelsPath, settingsPath];
	const originallyExisting = new Map<string, boolean>();
	const releases: Array<() => Promise<void>> = [];
	let committed = false;

	try {
		for (const path of targets) {
			originallyExisting.set(path, await pathExists(path));
			await ensureLockTarget(path, path === modelsPath ? '{\n  "providers": {}\n}\n' : "{}\n");
		}
		for (const path of targets) {
			releases.push(await acquireLock(path));
		}

		const [currentAuth, currentModels, currentSettings] = await Promise.all([
			readJsonObject(authPath, false),
			readJsonObject(modelsPath, false),
			readJsonObject(settingsPath, false),
		]);
		const targetValues = buildTargetValues(envelope, currentModels, currentSettings);

		if (
			isDeepStrictEqual(currentAuth, targetValues.authValue) &&
			isDeepStrictEqual(currentModels, targetValues.modelsValue) &&
			isDeepStrictEqual(currentSettings, targetValues.settingsValue)
		) {
			committed = true;
			return {
				syncId: envelope.syncId,
				status: "already_applied",
				personalProviderCount: providerCount,
				credentialCount,
				rolledBack: false,
			};
		}

		const snapshots = new Map<string, FileSnapshot>([
			[authPath, await snapshotFile(authPath)],
			[modelsPath, await snapshotFile(modelsPath)],
			[settingsPath, await snapshotFile(settingsPath)],
		]);
		const writes: Array<{ path: string; value: JsonObject }> = [
			{ path: authPath, value: targetValues.authValue },
			{ path: modelsPath, value: targetValues.modelsValue },
			{ path: settingsPath, value: targetValues.settingsValue },
		];
		const writtenPaths: string[] = [];

		try {
			for (const write of writes) {
				writtenPaths.push(write.path);
				await writeAtomic(write.path, encodeJson(write.value), FILE_MODE);
			}
		} catch (error) {
			const writeError = error instanceof Error ? error.message : String(error);
			let rollbackError: string | undefined;
			for (const path of [...writtenPaths].reverse()) {
				try {
					await restoreSnapshot(path, snapshots.get(path)!);
				} catch (error) {
					rollbackError ??= error instanceof Error ? error.message : String(error);
				}
			}
			if (rollbackError) {
				return failedResult(
					envelope.syncId,
					"rollback_failed",
					`Write failed: ${writeError}. Rollback failed: ${rollbackError}`,
					false,
					"rollback_failed",
					providerCount,
					credentialCount,
				);
			}
			return failedResult(
				envelope.syncId,
				"target_write_failed",
				`Write failed and all touched files were restored: ${writeError}`,
				true,
				"failed",
				providerCount,
				credentialCount,
			);
		}

		committed = true;
		return {
			syncId: envelope.syncId,
			status: "applied",
			personalProviderCount: providerCount,
			credentialCount,
			rolledBack: false,
		};
	} catch (error) {
		return failedResult(
			envelope.syncId,
			"target_read_failed",
			error instanceof Error ? error.message : String(error),
			true,
			"failed",
			providerCount,
			credentialCount,
		);
	} finally {
		for (const release of releases.reverse()) {
			try {
				await release();
			} catch {
				// Lock cleanup must not hide the transactional result.
			}
		}
		if (!committed) {
			for (const [path, existed] of originallyExisting) {
				if (!existed) {
					await rm(path, { force: true }).catch(() => undefined);
				}
			}
		}
	}
}

async function readStdinBounded(): Promise<string> {
	return await new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		process.stdin.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.length;
			if (total > MAX_ENVELOPE_BYTES) {
				reject(new Error(`Provider provisioning envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`));
				process.stdin.destroy();
				return;
			}
			chunks.push(bytes);
		});
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", reject);
		process.stdin.resume();
	});
}

export async function runProviderProvisioningMode(): Promise<void> {
	let syncId = "unknown";
	let result: ProviderProvisioningResult;
	try {
		const raw = await readStdinBounded();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			result = failedResult(
				syncId,
				"invalid_envelope",
				`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
			process.stdout.write(`${JSON.stringify(result)}\n`);
			return;
		}
		if (isObject(parsed) && typeof parsed.syncId === "string") {
			syncId = parsed.syncId;
		}
		const envelope = parseProviderProvisioningEnvelope(parsed);
		result = await applyProviderProvisioningEnvelope(envelope);
	} catch (error) {
		const tooLarge = error instanceof Error && error.message.includes("exceeds");
		result = failedResult(
			syncId,
			tooLarge ? "input_too_large" : "invalid_envelope",
			error instanceof Error ? error.message : String(error),
			true,
		);
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
