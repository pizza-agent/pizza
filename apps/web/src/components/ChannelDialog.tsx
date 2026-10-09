/**
 * Channel configuration modal — create or edit a message channel (Discord,
 * Lark, Slack, Telegram, or webhook). Mirrors the provider-config dialog flow:
 * a Modal wrapping a form, with Test + Save footer actions.
 *
 * The credential fields adapt to the selected type (token+target for chat
 * apps, webhook URL for webhooks). The "deliver to workspace" dropdown is the
 * target agent that inbound messages route to.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ErrorBanner, Field, Modal, Select } from "@/components/ui";
import {
	CHANNEL_TYPES,
	channelFieldSpec,
	saveChannel,
	testChannel,
	workspaceOptions,
	type ChannelInfo,
	type ChannelInput,
	type ChannelType,
	type WorkspaceOption,
} from "@/lib/channels";
import { MAIN_CHAT_CWD } from "@/lib/utils";

interface ChannelDialogProps {
	open: boolean;
	onClose: () => void;
	/** When editing, the existing channel; undefined when creating. */
	existing?: ChannelInfo | null;
	onSaved: (channel: ChannelInfo) => void;
}

export function ChannelDialog({ open, onClose, existing, onSaved }: ChannelDialogProps) {
	const { t } = useTranslation();
	const isEdit = !!existing;

	const [type, setType] = useState<ChannelType>(existing?.type ?? "discord");
	const [name, setName] = useState(existing?.name ?? "");
	const [token, setToken] = useState(existing?.token ?? "");
	const [appId, setAppId] = useState(existing?.appId ?? "");
	const [appSecret, setAppSecret] = useState(existing?.appSecret ?? "");
	const [appToken, setAppToken] = useState(existing?.appToken ?? "");
	const [webhookUrl, setWebhookUrl] = useState(existing?.webhookUrl ?? "");
	// New channels default to the persistent main assistant — same target the
	// sidebar's top "Agent" entry chats with.
	const [workspace, setWorkspace] = useState(existing?.workspace ?? MAIN_CHAT_CWD);
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	const [testMessage, setTestMessage] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Remount on `existing` so a fresh "Add" after an "Edit" resets all fields.
	useEffect(() => {
		if (!open) return;
		setType(existing?.type ?? "discord");
		setName(existing?.name ?? "");
		setToken(existing?.token ?? "");
		setAppId(existing?.appId ?? "");
		setAppSecret(existing?.appSecret ?? "");
		setAppToken(existing?.appToken ?? "");
		setWebhookUrl(existing?.webhookUrl ?? "");
		setWorkspace(existing?.workspace ?? MAIN_CHAT_CWD);
		setEnabled(existing?.enabled ?? true);
		setError(null);
		setTestMessage(null);
		setTesting(false);
		setSaving(false);
	}, [open, existing]);

	useEffect(() => {
		if (!open) return;
		workspaceOptions().then(setWorkspaces).catch(() => setWorkspaces([]));
	}, [open]);

	const spec = channelFieldSpec(type);

	function validate(): string | null {
		if (!name.trim()) return t("channels.dialog.nameRequired");
		if (!workspace) return t("channels.dialog.workspaceRequired");
		if (spec.token && !token.trim()) return t("channels.dialog.tokenRequired");
		if (spec.appCredentials && !appId.trim()) return t("channels.dialog.appIdRequired");
		if (spec.appCredentials && !appSecret.trim()) return t("channels.dialog.appSecretRequired");
		if (spec.appToken && !appToken.trim()) return t("channels.dialog.appTokenRequired");
		if (spec.webhook && !webhookUrl.trim()) return t("channels.dialog.urlRequired");
		return null;
	}

	async function handleTest() {
		const err = validate();
		if (err) {
			setError(err);
			return;
		}
		setError(null);
		setTesting(true);
		setTestMessage(null);
		try {
			// Save first (so testChannel has the latest config), then test.
			const input: ChannelInput = { type, name: name.trim(), token, appId, appSecret, appToken, webhookUrl, workspace, enabled };
			const saved = await saveChannel(existing?.id ?? null, input);
			const result = await testChannel(saved.id);
			setTestMessage(result.message);
			onSaved({ ...saved, status: result.ok ? "connected" : "error" });
		} catch (e) {
			setTestMessage(e instanceof Error ? e.message : String(e));
		} finally {
			setTesting(false);
		}
	}

	async function handleSave() {
		const err = validate();
		if (err) {
			setError(err);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			const input: ChannelInput = { type, name: name.trim(), token, appId, appSecret, appToken, webhookUrl, workspace, enabled };
			const saved = await saveChannel(existing?.id ?? null, input);
			onSaved(saved);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			size="md"
			backdrop={false}
			title={isEdit ? t("channels.dialog.editTitle") : t("channels.dialog.createTitle")}
			footer={
				<div className="flex w-full items-center justify-between gap-2">
					<Button tone="neutral" variant="ghost" size="sm" onClick={onClose}>
						{t("channels.dialog.cancel")}
					</Button>
					<div className="flex items-center gap-2">
						<Button tone="neutral" size="sm" loading={testing} disabled={saving} onClick={handleTest}>
							{testing ? t("channels.testing") : t("channels.test")}
						</Button>
						<Button size="sm" loading={saving} disabled={testing} onClick={handleSave}>
							{saving ? t("channels.saving") : t("channels.save")}
						</Button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				{error && <ErrorBanner message={error} />}
				{testMessage && (
					<div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
						{testMessage}
					</div>
				)}

				<div className="grid grid-cols-2 gap-3">
					<Field label={t("channels.dialog.type")}>
						<Select
							value={type}
							options={CHANNEL_TYPES.map((tk) => ({ value: tk, label: t(`channels.types.${tk}`) }))}
							onChange={(v) => setType(v as ChannelType)}
						/>
					</Field>
					<Field label={t("channels.dialog.name")}>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("channels.dialog.namePlaceholder")}
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				</div>

				{spec.appCredentials && (
					<>
						<Field label={t("channels.dialog.appId")} hint={t("channels.dialog.appIdHint")}>
							<input
								type="text"
								value={appId}
								onChange={(e) => setAppId(e.target.value)}
								placeholder="cli_…"
								className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							/>
						</Field>
						<Field label={t("channels.dialog.appSecret")} hint={t("channels.dialog.appSecretHint")}>
							<input
								type="password"
								value={appSecret}
								onChange={(e) => setAppSecret(e.target.value)}
								placeholder="••••••••"
								className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							/>
						</Field>
						<p className="text-xs text-muted">{t("channels.dialog.larkHint")}</p>
					</>
				)}
				{spec.token && (
					<Field label={t("channels.dialog.token")} hint={t("channels.dialog.tokenHint")}>
						<input
							type="password"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							placeholder="••••••••"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				)}
				{spec.appToken && (
					<Field label={t("channels.dialog.appToken")} hint={t("channels.dialog.appTokenHint")}>
						<input
							type="password"
							value={appToken}
							onChange={(e) => setAppToken(e.target.value)}
							placeholder="xapp-…"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				)}
				{spec.webhook && (
					<Field label={t("channels.dialog.webhookUrl")} hint={t("channels.dialog.urlHint")}>
						<input
							type="text"
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
							placeholder="https://hooks.example.com/…"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				)}

				<Field label={t("channels.dialog.workspace")} hint={t("channels.dialog.workspaceHint")}>
					{workspaces.length > 0 ? (
						<Select
							value={workspace}
							options={workspaces.map((o) =>
								o.main ? { ...o, label: t("layout.agent"), hint: t("layout.agentSubtitle") } : o,
							)}
							onChange={setWorkspace}
							placeholder={t("channels.dialog.workspacePlaceholder")}
						/>
					) : (
						<p className="text-xs text-muted">{t("channels.dialog.noWorkspaces")}</p>
					)}
				</Field>

				<Field label={t("channels.dialog.enabled")}>
					<label className="flex items-center gap-2 text-xs text-muted">
						<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
						{t("channels.dialog.enabledHint")}
					</label>
				</Field>
			</div>
		</Modal>
	);
}
