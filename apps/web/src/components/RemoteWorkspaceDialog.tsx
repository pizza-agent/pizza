/**
 * SSH workspace connection dialog.
 *
 * Authentication and directory browsing happen before the workspace is
 * persisted. The directory list is produced by the remote host, so users pick
 * a real server path instead of typing one from memory.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Eye, EyeOff, Folder, FolderSearch, Home, Loader2, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	addRemoteWorkspace,
	browseRemoteDirectories,
	type RemoteDirectoryListing,
	type RemoteWorkspaceInput,
} from "@/lib/transport";
import type { WorkspaceMeta } from "@/lib/types";
import { Button, ErrorBanner, Field, Modal } from "@/components/ui";
import { pathBasename } from "@/lib/utils";

interface RemoteWorkspaceDialogProps {
	open: boolean;
	onClose: () => void;
	onCreated: (workspace: WorkspaceMeta) => Promise<void> | void;
}

export function RemoteWorkspaceDialog({
	open,
	onClose,
	onCreated,
}: RemoteWorkspaceDialogProps) {
	const { t } = useTranslation();
	const [label, setLabel] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("root");
	const [port, setPort] = useState("");
	const [identityFile, setIdentityFile] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [remotePath, setRemotePath] = useState("");
	const [syncCredentials, setSyncCredentials] = useState(true);
	const [directoryListing, setDirectoryListing] = useState<RemoteDirectoryListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [browsing, setBrowsing] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const autoLabelRef = useRef("");

	useEffect(() => {
		if (!open) return;
		setLabel("");
		setHost("");
		setUsername("root");
		setPort("");
		setIdentityFile("");
		setPassword("");
		setShowPassword(false);
		setRemotePath("");
		setSyncCredentials(true);
		setDirectoryListing(null);
		setError(null);
		setBrowsing(false);
		setConnecting(false);
		autoLabelRef.current = "";
	}, [open]);

	function buildSshTarget(): string {
		const rawHost = host.trim();
		if (!rawHost) return "";
		if (rawHost.includes("@")) return rawHost;
		const user = username.trim();
		return user ? `${user}@${rawHost}` : rawHost;
	}

	function parsedPort(): number | undefined {
		if (!port.trim()) return undefined;
		const value = Number.parseInt(port.trim(), 10);
		if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
			throw new Error(t("remoteWorkspace.portInvalid"));
		}
		return value;
	}

	function resetRemoteSelection(): void {
		setDirectoryListing(null);
		setRemotePath("");
	}

	function suggestLabel(path: string): void {
		const suggestion = pathBasename(path) || host.trim();
		if (!label.trim() || label === autoLabelRef.current) {
			autoLabelRef.current = suggestion;
			setLabel(suggestion);
		}
	}

	async function selectIdentityFile(): Promise<void> {
		try {
			const dialog = await import("@tauri-apps/plugin-dialog");
			const selected = await dialog.open({
				directory: false,
				multiple: false,
				title: t("remoteWorkspace.selectIdentityFile"),
			});
			if (typeof selected === "string") {
				setIdentityFile(selected);
				resetRemoteSelection();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function browse(path?: string): Promise<void> {
		const target = buildSshTarget();
		if (!target) {
			setError(t("remoteWorkspace.sshTargetRequired"));
			return;
		}
		setError(null);
		setBrowsing(true);
		try {
			const listing = await browseRemoteDirectories(
				{
					sshTarget: target,
					port: parsedPort(),
					identityFile: identityFile.trim() || undefined,
					password: password || undefined,
				},
				path,
			);
			setDirectoryListing(listing);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBrowsing(false);
		}
	}

	function chooseDirectory(): void {
		if (!directoryListing) return;
		setRemotePath(directoryListing.currentPath);
		suggestLabel(directoryListing.currentPath);
		setDirectoryListing(null);
		setError(null);
	}

	async function connect(): Promise<void> {
		if (connecting) return;
		const trimmedLabel = label.trim();
		const target = buildSshTarget();
		const trimmedPath = remotePath.trim();
		if (!trimmedLabel) {
			setError(t("remoteWorkspace.nameRequired"));
			return;
		}
		if (!target) {
			setError(t("remoteWorkspace.sshTargetRequired"));
			return;
		}
		if (!trimmedPath) {
			setError(t("remoteWorkspace.remotePathRequired"));
			return;
		}

		const input: RemoteWorkspaceInput = {
			label: trimmedLabel,
			sshTarget: target,
			port: parsedPort(),
			identityFile: identityFile.trim() || undefined,
			password: password || undefined,
			remotePath: trimmedPath,
			syncCredentials,
		};
		setError(null);
		setConnecting(true);
		try {
			const workspace = await addRemoteWorkspace(input);
			await onCreated(workspace);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setConnecting(false);
		}
	}

	function closeDialog(): void {
		if (!connecting) onClose();
	}

	return (
		<Modal
			open={open}
			onClose={closeDialog}
			size="md"
			title={t("remoteWorkspace.title")}
			footer={
				<div className="flex w-full flex-col gap-3">
					{connecting && (
						<div
							role="status"
							aria-live="polite"
							className="flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5"
						>
							<Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
							<div className="space-y-0.5">
								<p className="text-xs font-medium text-fg">
									{t("remoteWorkspace.progressTitle")}
								</p>
								<p className="text-[11px] leading-relaxed text-muted">
									{t("remoteWorkspace.progressHint")}
								</p>
							</div>
						</div>
					)}
					<div className="flex items-center justify-between gap-2">
						<Button tone="neutral" variant="ghost" size="sm" disabled={connecting} onClick={onClose}>
							{t("common.cancel")}
						</Button>
						<Button
							size="sm"
							iconLeft={connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
							disabled={connecting || browsing}
							onClick={() => void connect()}
							className="min-w-[92px]"
						>
							{connecting ? t("remoteWorkspace.connecting") : t("remoteWorkspace.connect")}
						</Button>
					</div>
				</div>
			}
		>
			<div className="max-h-[68vh] space-y-4 overflow-y-auto pr-1">
				{error && <ErrorBanner message={error} />}
				<div className="flex items-start gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-3">
					<Server className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
					<div className="space-y-2">
						<p className="text-xs leading-relaxed text-muted">
							{t("remoteWorkspace.description")}
						</p>
						<p className="text-xs leading-relaxed text-muted">
							{t("remoteWorkspace.installPrerequisite")}
						</p>
					</div>
				</div>

				<Field label={t("remoteWorkspace.name")}>
					<input
						type="text"
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						placeholder={t("remoteWorkspace.namePlaceholder")}
						className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</Field>

				<div className="grid grid-cols-[minmax(0,1fr)_120px_82px] gap-2">
					<Field label={t("remoteWorkspace.sshTarget")} hint={t("remoteWorkspace.sshTargetHint")}>
						<input
							type="text"
							value={host}
							onChange={(event) => {
								setHost(event.target.value);
								resetRemoteSelection();
							}}
							placeholder="example.com"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
					<Field label={t("remoteWorkspace.username")} hint={t("remoteWorkspace.usernameHint")}>
						<input
							type="text"
							value={username}
							onChange={(event) => {
								setUsername(event.target.value);
								resetRemoteSelection();
							}}
							placeholder="root"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
					<Field label={t("remoteWorkspace.port")}>
						<input
							type="number"
							min={1}
							max={65535}
							value={port}
							onChange={(event) => {
								setPort(event.target.value);
								resetRemoteSelection();
							}}
							placeholder="22"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				</div>

				<Field label={t("remoteWorkspace.password")} hint={t("remoteWorkspace.passwordHint")}>
					<div className="relative">
						<input
							type={showPassword ? "text" : "password"}
							value={password}
							onChange={(event) => {
								setPassword(event.target.value);
								resetRemoteSelection();
							}}
							placeholder={t("remoteWorkspace.passwordPlaceholder")}
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 pr-10 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
						<button
							type="button"
							onClick={() => setShowPassword((value) => !value)}
							className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
							title={showPassword ? t("remoteWorkspace.hidePassword") : t("remoteWorkspace.showPassword")}
						>
							{showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
				</Field>

				<Field label={t("remoteWorkspace.identityFile")} hint={t("remoteWorkspace.identityFileHint")}>
					<div className="flex gap-2">
						<input
							type="text"
							value={identityFile}
							onChange={(event) => {
								setIdentityFile(event.target.value);
								resetRemoteSelection();
							}}
							placeholder="~/.ssh/id_ed25519"
							className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
						<Button
							tone="neutral"
							size="sm"
							iconLeft={<FolderSearch className="h-3.5 w-3.5" />}
							onClick={() => void selectIdentityFile()}
						>
							{t("remoteWorkspace.browse")}
						</Button>
					</div>
				</Field>

				{!directoryListing && (
					<Button
						tone="neutral"
						size="sm"
						iconLeft={<Server className="h-3.5 w-3.5" />}
						loading={browsing}
						disabled={connecting}
						onClick={() => void browse()}
					>
						{browsing ? t("remoteWorkspace.browsing") : t("remoteWorkspace.connectAndBrowse")}
					</Button>
				)}

				{directoryListing && (
					<div className="overflow-hidden rounded-lg border border-border bg-surface">
						<div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2">
							<Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
							<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={directoryListing.currentPath}>
								{directoryListing.currentPath}
							</span>
							<button
								type="button"
								onClick={() => void browse(directoryListing.homePath)}
								className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
								title={t("remoteWorkspace.homeDirectory")}
							>
								<Home className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								disabled={!directoryListing.parentPath}
								onClick={() => directoryListing.parentPath && void browse(directoryListing.parentPath)}
								className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35"
								title={t("remoteWorkspace.parentDirectory")}
							>
								<ArrowUp className="h-3.5 w-3.5" />
							</button>
						</div>
						<div className="max-h-44 overflow-y-auto p-1">
							{directoryListing.entries.length === 0 ? (
								<p className="px-3 py-4 text-center text-xs text-muted">
									{t("remoteWorkspace.noDirectories")}
								</p>
							) : (
								directoryListing.entries.map((entry) => (
									<button
										key={entry.path}
										type="button"
										onClick={() => void browse(entry.path)}
										className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs text-fg hover:bg-surface-2"
									>
										<Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
										<span className="truncate">{entry.name}</span>
									</button>
								))
							)}
						</div>
						<div className="flex items-center justify-end gap-2 border-t border-border px-2 py-2">
							<Button tone="neutral" variant="ghost" size="sm" onClick={() => setDirectoryListing(null)}>
								{t("remoteWorkspace.cancelBrowse")}
							</Button>
							<Button size="sm" onClick={chooseDirectory}>
								{t("remoteWorkspace.selectDirectory")}
							</Button>
						</div>
					</div>
				)}

				<Field label={t("remoteWorkspace.remotePath")} hint={t("remoteWorkspace.remotePathHint")}>
					<input
						type="text"
						value={remotePath}
						onChange={(event) => setRemotePath(event.target.value)}
						onBlur={(event) => suggestLabel(event.target.value.trim())}
						placeholder="/srv/projects/my-app"
						className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</Field>

				<label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2.5">
					<input
						type="checkbox"
						checked={syncCredentials}
						onChange={(event) => setSyncCredentials(event.target.checked)}
						className="mt-0.5 accent-accent"
					/>
					<span className="space-y-0.5">
						<span className="block text-xs font-medium text-fg">{t("remoteWorkspace.syncCredentials")}</span>
						<span className="block text-[11px] leading-relaxed text-muted">
							{t("remoteWorkspace.syncCredentialsHint")}
						</span>
					</span>
				</label>
			</div>
		</Modal>
	);
}
