import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import type { InteractionAnswer, InteractionRecord } from "@/lib/interactions";

export function InteractionCard({
	record,
	onRespond,
}: {
	record: InteractionRecord;
	onRespond: (record: InteractionRecord, answer: InteractionAnswer) => Promise<void>;
}) {
	const { t } = useTranslation();
	const prefix = useId();
	const [values, setValues] = useState<Record<string, string | string[]>>({}),
		[text, setText] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const sending = useRef(false);
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const delay = record.expiresAt - Date.now();
		if (delay <= 0) {
			setNow(Date.now());
			return;
		}
		const timer = setTimeout(() => setNow(Date.now()), delay);
		return () => clearTimeout(timer);
	}, [record.expiresAt]);
	const pending = record.status === "pending" && record.expiresAt > now;
	const answer = record.answer,
		shown = answer?.kind === "submit" ? answer.values : values;
	const send = async (answer: InteractionAnswer) => {
		if (sending.current || !pending) return;
		sending.current = true;
		setBusy(true);
		setError("");
		try {
			await onRespond(record, answer);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			sending.current = false;
			setBusy(false);
		}
	};
	const submit = (actionId?: string) => {
		for (const f of record.card.fields ?? []) {
			const v = values[f.id];
			if (f.required && (v === undefined || (typeof v === "string" ? !v.trim() : !v.length))) {
				setError(t("interaction.required", { label: f.label }));
				return;
			}
		}
		void send({ kind: "submit", values, ...(actionId ? { actionId } : {}) });
	};
	return (
		<section
			data-interaction-card={record.id}
			aria-label={record.card.title}
			className="my-4 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5"
		>
			<div className="flex items-start justify-between gap-3">
				<h3 className="text-sm font-semibold text-fg">{record.card.title}</h3>
				{!pending && (
					<span className="flex shrink-0 items-center gap-1 text-xs text-muted">
						{record.status === "answered" && <Check className="h-3.5 w-3.5" />}
						{t(`interaction.${record.status === "pending" ? "expired" : record.status}`)}
					</span>
				)}
			</div>
			{record.card.description && (
				<p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">{record.card.description}</p>
			)}
			{answer?.kind === "text" ? (
				<p className="mt-3 whitespace-pre-wrap text-sm text-fg">{answer.text}</p>
			) : (
				record.status !== "skipped" && (
					<div className="mt-4 space-y-4">
						{(record.card.fields ?? []).map((f) => (
							<fieldset key={f.id} disabled={!pending || busy} className="min-w-0">
								<legend className="mb-1.5 text-xs font-medium text-fg">
									{f.label}
									{f.required && <span className="ml-1 text-muted">*</span>}
								</legend>
								{f.description && <p className="mb-2 text-xs text-muted">{f.description}</p>}
								{f.type === "text" ? (
									<input
										id={`${prefix}-${f.id}`}
										aria-label={f.label}
										aria-required={f.required}
										maxLength={8000}
										value={typeof shown[f.id] === "string" ? shown[f.id] : ""}
										placeholder={f.placeholder}
										onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
										className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:bg-surface-2/30"
									/>
								) : (
									<div className="space-y-1.5">
										{f.options?.map((o) => {
											const selected =
												f.type === "multi"
													? Array.isArray(shown[f.id]) && (shown[f.id] as string[]).includes(o.id)
													: shown[f.id] === o.id;
											return (
												<label
													key={o.id}
													className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${selected ? "border-accent/50 bg-accent/5" : "border-border"} ${pending ? "cursor-pointer hover:bg-surface-2/50" : ""}`}
												>
													<input
														type={f.type === "multi" ? "checkbox" : "radio"}
														name={`${prefix}-${f.id}`}
														value={o.id}
														checked={selected}
														className="mt-0.5 accent-accent"
														onChange={() =>
															setValues((v) => {
																if (f.type === "select") return { ...v, [f.id]: o.id };
																const previous = Array.isArray(v[f.id]) ? (v[f.id] as string[]) : [];
																return {
																	...v,
																	[f.id]: previous.includes(o.id)
																		? previous.filter((x) => x !== o.id)
																		: [...previous, o.id],
																};
															})
														}
													/>
													<span>
														<span className="block text-xs font-medium">{o.label}</span>
														{o.description && <span className="mt-1 block text-xs text-muted">{o.description}</span>}
													</span>
												</label>
											);
										})}
									</div>
								)}
							</fieldset>
						))}
					</div>
				)
			)}
			{answer?.kind === "submit" && answer.actionId && (
				<p className="mt-3 text-xs text-muted">{record.card.actions?.find((a) => a.id === answer.actionId)?.label}</p>
			)}
			{pending && (
				<>
					<div className="mt-4 flex flex-wrap items-center gap-2">
						{(record.card.actions ?? []).map((a) => (
							<Button key={a.id} size="sm" disabled={busy} onClick={() => submit(a.id)}>
								{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
								{a.label}
							</Button>
						))}
						{((record.card.fields?.length ?? 0) > 0 || !record.card.actions?.length) && (
							<Button size="sm" disabled={busy} onClick={() => submit()}>
								{record.card.submitLabel ?? t("interaction.submit")}
							</Button>
						)}
						{record.card.allowSkip !== false && (
							<Button
								size="sm"
								tone="neutral"
								variant="ghost"
								disabled={busy}
								onClick={() => void send({ kind: "skip" })}
							>
								{t("interaction.skip")}
							</Button>
						)}
					</div>
					<details className="mt-3 text-xs text-muted">
						<summary className="w-fit cursor-pointer hover:text-fg">{t("interaction.sayInstead")}</summary>
						<div className="mt-2 flex gap-2">
							<input
								aria-label={t("interaction.sayInstead")}
								maxLength={8000}
								value={text}
								disabled={busy}
								onChange={(e) => setText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && text.trim()) {
										e.preventDefault();
										void send({ kind: "text", text });
									}
								}}
								className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
							/>
							<Button
								size="sm"
								tone="neutral"
								disabled={busy || !text.trim()}
								onClick={() => void send({ kind: "text", text })}
							>
								{t("interaction.submit")}
							</Button>
						</div>
					</details>
				</>
			)}
			{error && (
				<p role="alert" className="mt-3 text-xs text-danger">
					{error}
				</p>
			)}
		</section>
	);
}
