import { getRpcWorkspace, subscribeRpcWorkspace } from "./transport";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MCP_LOGIN_RPC_TIMEOUT_MS } from "@tomsun28/pizza-protocol";
import { subscribeMcpAuthSession } from "./mcp-auth-session";
import { canPasteMcpRedirect, type McpDevicePrompt } from "./mcp-signin";
export function useMcpAuthSession(
	command: (args: string[], timeout?: number) => Promise<unknown>,
	refresh: () => Promise<{ name: string; state: string }[]>,
	setError: (error: string) => void,
) {
	const [login, setLogin] = useState<{
		name: string;
		authUrl: string;
		busy: boolean;
		error: string;
		device?: McpDevicePrompt;
	} | null>(null);
	const [loginAnswer, setLoginAnswer] = useState("");
	const [loginSubmitting, setLoginSubmitting] = useState(false);
	const loginActive = useRef(false);
	const loginRequest = useRef(0);
	const workspace = useSyncExternalStore(subscribeRpcWorkspace, getRpcWorkspace, getRpcWorkspace);
	const disposeAttempt = useCallback(() => {
		loginRequest.current++;
		if (loginActive.current && getRpcWorkspace() === workspace)
			void command(["server", "login-cancel"], 10000).catch(() => {});
		loginActive.current = false;
	}, [workspace, command]);
	useEffect(() => {
		setLogin(null);
		setLoginAnswer("");
		setLoginSubmitting(false);
		return disposeAttempt;
	}, [disposeAttempt]);

	async function cancelLogin() {
		const request = ++loginRequest.current;
		loginActive.current = false;
		try {
			await command(["server", "login-cancel"], 10000);
		} catch {
			/* best-effort */
		}
		if (request === loginRequest.current && workspace === getRpcWorkspace()) {
			setLogin(null);
			setLoginAnswer("");
			setLoginSubmitting(false);
		}
	}

	async function submitLoginAnswer() {
		const request = loginRequest.current;
		const value = loginAnswer.trim();
		if (!value || !login || !canPasteMcpRedirect(login)) return;
		setLoginSubmitting(true);
		setLogin((prev) => (prev ? { ...prev, error: "" } : prev));
		try {
			await command(["server", "login-answer", value], 15000);
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			setLoginAnswer("");
		} catch (e) {
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			setLogin((prev) => (prev ? { ...prev, error: e instanceof Error ? e.message : String(e), busy: true } : prev));
			setLoginSubmitting(false);
		}
	}

	async function beginSignIn(serverName: string) {
		if (loginActive.current) return;
		const request = ++loginRequest.current;
		loginActive.current = true;
		setLoginAnswer("");
		setLoginSubmitting(false);
		setLogin({ name: serverName, authUrl: "", busy: true, error: "" });
		setError("");
		let unsub: (() => void) | undefined;
		try {
			unsub = await subscribeMcpAuthSession(serverName, (update) => {
				if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
				setLogin((prev) => (prev?.name === serverName ? { ...prev, ...update } : prev));
			});
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			await command(["server", "login", serverName], MCP_LOGIN_RPC_TIMEOUT_MS);
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			setLogin(null);
			await refresh();
		} catch (e) {
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			const cancelled = e instanceof Error && "cancelled" in e && (e as Error & { cancelled?: boolean }).cancelled;
			if (cancelled) {
				setLogin(null);
				return;
			}
			const message = e instanceof Error ? e.message : String(e);
			const listed = await refresh();
			if (request !== loginRequest.current || workspace !== getRpcWorkspace()) return;
			// Older gateways may time out while the agent completes OAuth in the background.
			if (
				/timeout|timed?\s*out/i.test(message) &&
				listed.some((server) => server.name === serverName && server.state === "connected")
			) {
				setLogin(null);
				setError("");
				return;
			}
			setLogin((prev) => (prev ? { ...prev, busy: false, error: message } : prev));
			setError(message);
		} finally {
			unsub?.();
			if (request === loginRequest.current && workspace === getRpcWorkspace()) {
				loginActive.current = false;
				setLoginSubmitting(false);
			}
		}
	}

	return { login, loginAnswer, setLoginAnswer, loginSubmitting, cancelLogin, submitLoginAnswer, beginSignIn };
}
