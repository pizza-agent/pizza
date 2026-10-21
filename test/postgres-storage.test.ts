import { describe, expect, it } from "vitest";
import { PostgresEventStorage, type PostgresConnection } from "../src/core/event-store/postgres-storage.js";
import { AsyncProjectionStore } from "../src/core/event-store/async-projection-store.js";

/** Minimal scripted pg connection: enough to exercise lifecycle guards without a server. */
function fakePool(options: { locked?: boolean } = {}) {
	const queries: string[] = [];
	let released = 0;
	const connection: PostgresConnection = {
		async query(sql: string) {
			queries.push(sql);
			if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: options.locked ?? true }] };
			if (sql.startsWith("SELECT head_sequence")) return { rows: [{ head_sequence: "0", index_json: null, legacy_imported: false }] };
			if (sql.startsWith("UPDATE")) return { rows: [{ head_sequence: 1 }] };
			return { rows: [] };
		},
		release() {
			released++;
		},
	};
	return { pool: { connect: async () => connection }, queries, released: () => released };
}
const scope = { tenantId: "t", workspaceId: "ws", scopeId: "s" };

describe("PostgresEventStorage lifecycle guards", () => {
	it("rejects a second writer for the same scope and releases the connection", async () => {
		const fake = fakePool({ locked: false });
		await expect(PostgresEventStorage.open(fake.pool, scope)).rejects.toThrow("active writer");
		expect(fake.released()).toBe(1);
	});
	it("rejects invalid schema and scope identifiers before connecting", async () => {
		const fake = fakePool();
		await expect(PostgresEventStorage.open(fake.pool, { ...scope, schema: 'x"; drop' })).rejects.toThrow("schema");
		await expect(PostgresEventStorage.open(fake.pool, { ...scope, tenantId: "" })).rejects.toThrow("scope");
		expect(fake.queries).toHaveLength(0);
	});
	it("refuses blind commits before restore and imports after restore", async () => {
		const fake = fakePool();
		const backend = await PostgresEventStorage.open(fake.pool, scope);
		await expect(backend.commit([])).rejects.toThrow("restored");
		const store = await AsyncProjectionStore.open(backend);
		await expect(backend.importLegacy({ events: [] })).rejects.toThrow("before AsyncProjectionStore.open");
		await store.closeAsync();
		expect(fake.queries.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
		expect(fake.released()).toBe(1);
	});
});