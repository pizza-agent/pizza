import { answeredRows, choiceMark, quickChoices } from "@/lib/interaction-presentation";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
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
	const customInput = useRef<HTMLInputElement>(null);
	const [customOpen, setCustomOpen] = useState(false);
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
	const shown = values;
	const send = async (answer: InteractionAnswer) => {
		if (sending.current || (!pending && record.delivery !== "pending")) return;
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

	const choices = quickChoices(record.card);
	const complete = !!record.answer || record.status === "skipped";
	const delivery =
		record.delivery === "pending" && record.answer ? (
			<div className="mt-4 flex items-center gap-3 text-xs text-muted">
				<span>{t("interaction.deliveryPending")}</span>
				<Button size="sm" tone="neutral" disabled={busy} onClick={() => void send(record.answer!)}>
					{t("interaction.retryDelivery")}
				</Button>
			</div>
		) : null;
	const failure = error ? (
		<p role="alert" className="mt-3 text-xs text-danger">
			{error}
		</p>
	) : null;
	const frame = "my-4 rounded-3xl border border-border bg-surface px-5 py-5 sm:px-6";
	const markClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm font-medium";
	const openCustom = () => {
		setCustomOpen(true);
		requestAnimationFrame(() => customInput.current?.focus());
	};
	if (complete)
		return (
			<section data-interaction-card={record.id} aria-label={record.card.title} className={frame}>
				<h3 className="text-sm font-semibold text-muted">{record.card.title}</h3>
				{record.status === "skipped" || record.answer?.kind === "skip" ? (
					<p className="mt-4 text-sm text-muted">{t("interaction.skipped")}</p>
				) : (
					<div className="mt-4 space-y-3">
						{answeredRows(record).map((row, i) => (
							<div key={i} className="flex items-start gap-3">
								{row.mark && <span className={`${markClass} bg-accent text-accent-fg`}>{row.mark}</span>}
								<div className="min-w-0 py-1">
									{row.label && (!choices || row.label !== record.card.title) && (
										<p className="mb-1 text-xs text-muted">{row.label}</p>
									)}
									<p className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-fg">
										{row.text}
									</p>
								</div>
							</div>
						))}
					</div>
				)}
				{delivery}
				{failure}
			</section>
		);
	if (choices)
		return (
			<section data-interaction-card={record.id} aria-label={record.card.title} aria-busy={busy} className={frame}>
				<h3 className="text-sm font-semibold text-fg">{record.card.title}</h3>
				{record.card.fields?.[0] && record.card.fields[0].label !== record.card.title && (
					<p className="mt-3 text-sm font-medium text-fg">{record.card.fields[0].label}</p>
				)}
				{record.card.description && (
					<p className="mt-2 text-xs leading-relaxed text-muted">{record.card.description}</p>
				)}
				{record.card.fields?.[0]?.description && (
					<p className="mt-2 text-xs text-muted">{record.card.fields[0].description}</p>
				)}
				<div className="mt-4 space-y-1">
					{choices.map((choice) => (
						<button
							key={choice.id}
							type="button"
							disabled={!pending || busy}
							onClick={() => void send(choice.answer)}
							className="group flex w-full items-start gap-3 rounded-xl py-2.5 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-60"
						>
							<span
								className={`${markClass} border border-border bg-surface-2 text-muted group-hover:border-accent/30 group-hover:text-fg`}
							>
								{choice.mark}
							</span>
							<span className="min-w-0 py-1 break-words text-sm font-medium leading-relaxed text-fg">
								{choice.label}
								{choice.description && (
									<span className="mt-1 block text-xs font-normal text-muted">{choice.description}</span>
								)}
							</span>
						</button>
					))}
					{pending && (
						<button
							type="button"
							disabled={busy}
							aria-expanded={customOpen}
							onClick={openCustom}
							className="flex w-full items-center gap-3 rounded-xl py-2.5 text-left text-muted outline-none hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
						>
							<span className={`${markClass} border border-border bg-surface-2`}>{choiceMark(choices.length)}</span>
							<span className="text-sm">{t("interaction.other")}</span>
						</button>
					)}
				</div>
				{customOpen && pending && (
					<form
						className="mt-3 flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (text.trim() && !busy) void send({ kind: "text", text });
						}}
					>
						<input
							ref={customInput}
							aria-label={t("interaction.sayInstead")}
							maxLength={8000}
							placeholder={t("interaction.customPlaceholder")}
							value={text}
							disabled={busy}
							onKeyDown={(e) => {
								if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
							}}
							onChange={(e) => setText(e.target.value)}
							className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
						/>
						<Button type="submit" size="sm" disabled={busy || !text.trim()}>
							{t("interaction.submit")}
						</Button>
					</form>
				)}
				<div className="mt-2 flex min-h-5 items-center justify-end gap-3 text-xs text-muted">
					{busy && (
						<span role="status" className="flex items-center gap-1.5">
							<Loader2 className="h-3 w-3 animate-spin" />
							{t("interaction.submitting")}
						</span>
					)}
					{pending && record.card.allowSkip !== false && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void send({ kind: "skip" })}
							className="rounded px-1 py-1 hover:text-fg focus-visible:outline-accent"
						>
							{t("interaction.skip")}
						</button>
					)}
					{!pending && <span>{t("interaction.expired")}</span>}
				</div>
				{failure}
			</section>
		);
	return (
		<section data-interaction-card={record.id} aria-label={record.card.title} className={frame}>
			<div className="flex items-start justify-between gap-3">
				<h3 className="text-sm font-semibold text-fg">{record.card.title}</h3>
				{!pending && (
					<span className="flex shrink-0 items-center gap-1 text-xs text-muted">
						{t(`interaction.${record.status === "pending" ? "expired" : record.status}`)}
					</span>
				)}
			</div>
			{record.card.description && (
				<p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">{record.card.description}</p>
			)}
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
									if (e.key === "Enter" && !e.nativeEvent.isComposing && text.trim()) {
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
			{failure}
		</section>
	);
}
