/**
 * In-process binding to libagent_desktop_ffi (the agent-desktop C ABI).
 *
 * The dylib is loaded lazily and only inside the desktop worker — never in the
 * agent process itself. bun:ffi is a Bun-only module, so every entry point
 * degrades to `undefined` under Node and the worker falls back to spawning the
 * agent-desktop CLI for that command.
 *
 * Ownership rules from agent_desktop.h: every `char **out` string is freed via
 * ad_free_string; adapters are freed via ad_adapter_destroy. Calls may run on
 * any thread but are synchronous, which is why they live in the worker.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const AD_ABI_VERSION_MAJOR = 7;

const DYLIB_NAMES: Record<string, string> = {
	darwin: "libagent_desktop_ffi.dylib",
	linux: "libagent_desktop_ffi.so",
	win32: "agent_desktop_ffi.dll",
};

export function dylibName(platform = process.platform): string | undefined {
	return DYLIB_NAMES[platform];
}

/** Locate the FFI dylib. Env override first, then next to the Pizza binary
 * (packaged Resources dir), then inside the agent-desktop npm package. */
export function resolveDesktopDylib(): string | undefined {
	const name = dylibName();
	if (!name) return undefined;
	const override = process.env.PIZZA_DESKTOP_DYLIB;
	if (override && existsSync(override)) return override;
	const alongside = join(dirname(process.execPath), name);
	if (existsSync(alongside)) return alongside;
	try {
		const req = createRequire(import.meta.url);
		const packageJson = req.resolve("agent-desktop/package.json");
		const candidate = join(dirname(packageJson), "lib", name);
		if (existsSync(candidate)) return candidate;
	} catch {
		// package or dylib not installed here
	}
	return undefined;
}

export interface FfiSnapshotOptions {
	app?: string;
	/** AdSnapshotSurface discriminant; 0 = window, 1 = focused. */
	surface: number;
	/** CLI default is 10; 0 is taken literally (root node only). */
	maxDepth: number;
	interactiveOnly: boolean;
	compact: boolean;
}

export const FFI_ACTION_KIND: Record<string, number> = {
	click: 0,
	"double-click": 1,
	"right-click": 2,
	"triple-click": 3,
	"set-value": 4,
	"set-focus": 5,
	expand: 6,
	collapse: 7,
	select: 8,
	toggle: 9,
	check: 10,
	uncheck: 11,
	scroll: 12,
	"scroll-to": 13,
	"press-key": 14,
	"key-down": 15,
	"key-up": 16,
	type: 17,
	clear: 18,
	hover: 19,
	drag: 20,
};

interface BunFfi {
	dlopen: (
		path: string,
		defs: Record<string, { args: unknown[]; returns: unknown }>,
	) => { symbols: Record<string, (...args: unknown[]) => unknown> };
	FFIType: Record<string, unknown>;
	ptr: (buf: ArrayBuffer | ArrayBufferView) => unknown;
	CString: new (p: number | bigint) => { toString(): string };
}

export interface FfiAdapter {
	/** JSON envelope string, identical in shape to the CLI output. */
	snapshot(options: FfiSnapshotOptions, sessionId?: string): string;
	status(): string;
	executeRef(ref: string, actionBytes: ArrayBuffer, sessionId?: string): string;
	/** Raw AdResult codes; 0 = OK. */
	checkPermissions(): number;
	version(): string;
	clipboardGet(): string;
	clipboardSet(text: string): number;
	closeApp(id: string, force: boolean): number;
	listApps(): Array<{ name?: string; pid?: number; bundleId?: string }>;
	readonly available: boolean;
}

function encodeCString(text: string): Buffer {
	return Buffer.from(`${text}\0`, "utf8");
}

/** Build the 96-byte AdAction struct. Layout (arm64/x64):
 * 0  i32 kind | 8 char* text | 16 scroll{i32 dir,u32 amount}
 * 24 key{char* key, i32* mods, u32 count, pad} | 48 drag{from 16B,to 16B,u64,u64} */
export function buildAction(options: {
	kind: number;
	text?: string;
	direction?: number;
	amount?: number;
	key?: string;
}): ArrayBuffer {
	const buf = new ArrayBuffer(96);
	const view = new DataView(buf);
	view.setInt32(0, options.kind, true);
	if (options.text !== undefined) {
		const encoded = encodeCString(options.text);
		view.setBigUint64(8, BigInt(ptrOf(encoded)), true);
		actionKeepalive.push(encoded);
	}
	if (options.direction !== undefined) {
		view.setInt32(16, options.direction, true);
		view.setUint32(20, options.amount ?? 0, true);
	}
	if (options.key !== undefined) {
		const encoded = encodeCString(options.key);
		view.setBigUint64(24, BigInt(ptrOf(encoded)), true);
		actionKeepalive.push(encoded);
	}
	return buf;
}

/** Buffers referenced by an in-flight AdAction must stay alive until the FFI
 * call returns; the calls are synchronous, so a single list drained after each
 * call is enough. */
const actionKeepalive: Buffer[] = [];

let ptrOf: (buf: ArrayBuffer | ArrayBufferView) => number | bigint = () => 0;

export async function loadDesktopFfi(): Promise<FfiAdapter | undefined> {
	const dylib = resolveDesktopDylib();
	if (!dylib) return undefined;
	let ffi: BunFfi;
	try {
		// @ts-expect-error — bun:ffi has no type declarations here; it only
		// resolves inside a Bun runtime, which is the only place this loads.
		ffi = (await import("bun:ffi")) as unknown as BunFfi;
	} catch {
		return undefined; // Node runtime — no bun:ffi
	}
	const { dlopen, FFIType, ptr, CString } = ffi;
	const read = (ffi as unknown as { read: Record<string, (p: number, offset?: number) => number | bigint> }).read;
	ptrOf = ptr as typeof ptrOf;
	let symbols: Record<string, (...args: unknown[]) => unknown>;
	try {
		({ symbols } = dlopen(dylib, {
			ad_init: { args: [FFIType.u32], returns: FFIType.i32 },
			ad_adapter_create: { args: [], returns: FFIType.ptr },
			ad_adapter_create_with_session: { args: [FFIType.ptr], returns: FFIType.ptr },
			ad_adapter_destroy: { args: [FFIType.ptr], returns: FFIType.void },
			ad_check_permissions: { args: [FFIType.ptr], returns: FFIType.i32 },
			ad_status: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ad_snapshot: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u8, FFIType.bool, FFIType.bool, FFIType.ptr],
				returns: FFIType.i32,
			},
			ad_execute_by_ref: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
			ad_free_string: { args: [FFIType.ptr], returns: FFIType.void },
			ad_version: { args: [FFIType.ptr], returns: FFIType.i32 },
			ad_get_clipboard: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ad_set_clipboard: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ad_close_app: { args: [FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.i32 },
			ad_list_apps: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			ad_app_list_count: { args: [FFIType.ptr], returns: FFIType.u32 },
			ad_app_list_get: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
			ad_app_list_free: { args: [FFIType.ptr], returns: FFIType.void },
		}));
	} catch {
		return undefined;
	}
	if (symbols.ad_init(AD_ABI_VERSION_MAJOR) !== 0) return undefined;

	const adapters = new Map<string | undefined, number>();
	function adapterFor(sessionId?: string): number {
		const key = sessionId || undefined;
		let handle = adapters.get(key);
		if (!handle) {
			handle = key
				? (symbols.ad_adapter_create_with_session(ptr(encodeCString(key))) as number)
				: (symbols.ad_adapter_create() as number);
			adapters.set(key, handle);
		}
		return handle;
	}

	function takeString(out: BigUint64Array): string {
		const p = Number(out[0]);
		out[0] = 0n;
		if (!p) return "";
		const text = new CString(p).toString();
		symbols.ad_free_string(p);
		return text;
	}

	return {
		available: true,
		checkPermissions: () => symbols.ad_check_permissions(adapterFor()) as number,
		status() {
			const out = new BigUint64Array(1);
			symbols.ad_status(adapterFor(), ptr(out));
			return takeString(out);
		},
		snapshot(options, sessionId) {
			const out = new BigUint64Array(1);
			symbols.ad_snapshot(
				adapterFor(sessionId),
				options.app ? ptr(encodeCString(options.app)) : null,
				options.surface,
				options.maxDepth,
				options.interactiveOnly,
				options.compact,
				ptr(out),
			);
			return takeString(out);
		},
		executeRef(ref, actionBytes, sessionId) {
			const out = new BigUint64Array(1);
			try {
				symbols.ad_execute_by_ref(adapterFor(sessionId), ptr(encodeCString(ref)), ptr(actionBytes), 0, ptr(out));
			} finally {
				actionKeepalive.length = 0;
			}
			return takeString(out);
		},
		version() {
			const out = new BigUint64Array(1);
			symbols.ad_version(ptr(out));
			return takeString(out);
		},
		clipboardGet() {
			const out = new BigUint64Array(1);
			symbols.ad_get_clipboard(adapterFor(), ptr(out));
			return takeString(out);
		},
		clipboardSet(text) {
			return symbols.ad_set_clipboard(adapterFor(), ptr(encodeCString(text))) as number;
		},
		closeApp(id, force) {
			return symbols.ad_close_app(adapterFor(), ptr(encodeCString(id)), force) as number;
		},
		listApps() {
			const listOut = new BigUint64Array(1);
			if (symbols.ad_list_apps(adapterFor(), ptr(listOut)) !== 0 || !listOut[0]) return [];
			const list = Number(listOut[0]);
			try {
				const count = symbols.ad_app_list_count(list) as number;
				const apps: Array<{ name?: string; pid?: number; bundleId?: string }> = [];
				for (let i = 0; i < count; i++) {
					const info = symbols.ad_app_list_get(list, i) as number;
					if (!info) continue;
					// AdAppInfo { char* name @0, u32 pid @8, char* bundle_id @16 }
					const readStr = (off: number) => {
						const p = read.ptr(info, off);
						return p ? new CString(p).toString() : undefined;
					};
					apps.push({ name: readStr(0), pid: Number(read.u32(info, 8)), bundleId: readStr(16) });
				}
				return apps;
			} finally {
				symbols.ad_app_list_free(list);
			}
		},
	};
}
