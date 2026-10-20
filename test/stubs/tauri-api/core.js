// Test stub for @tauri-apps/api/core — root `npm test` runs without
// apps/web/node_modules installed, so web sources' dynamic imports of
// @tauri-apps/* resolve to this stub. Tests override the no-ops with
// vi.mock("@tauri-apps/api/core") or vi.spyOn.
export async function invoke() {
	throw new Error("@tauri-apps/api stub: invoke is unavailable outside the Tauri shell");
}

export function transformCallback() {
	return 0;
}

export function convertFileSrc(path) {
	return path;
}