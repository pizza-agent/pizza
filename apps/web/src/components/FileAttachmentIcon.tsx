import { cn } from "@/lib/utils";

const FILE_TYPE_TONES: { match: RegExp; label: string; tone: string }[] = [
	{ match: /^image\//i, label: "IMG", tone: "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-100" },
	{ match: /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/i, label: "IMG", tone: "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-100" },
	{ match: /\.(pdf)$/i, label: "PDF", tone: "border-red-300 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-950/70 dark:text-red-100" },
	{ match: /\.(docx?|doc)$/i, label: "DOC", tone: "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-700 dark:bg-blue-950/70 dark:text-blue-100" },
	{ match: /\.(xlsx?|csv|xls)$/i, label: "XLS", tone: "border-green-300 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-950/70 dark:text-green-100" },
	{ match: /\.(pptx?|ppt)$/i, label: "PPT", tone: "border-orange-300 bg-orange-100 text-orange-900 dark:border-orange-700 dark:bg-orange-950/70 dark:text-orange-100" },
	{ match: /\.(zip|7z|rar|tar|gz|bz2|xz)$/i, label: "ZIP", tone: "border-yellow-300 bg-yellow-100 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950/70 dark:text-yellow-100" },
	{ match: /\.(md|markdown|mdx)$/i, label: "MD", tone: "border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" },
	{ match: /\.(txt|log)$/i, label: "TXT", tone: "border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" },
	{ match: /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i, label: "JS", tone: "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-100" },
	{ match: /\.(py|ipynb)$/i, label: "PY", tone: "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-100" },
	{ match: /\.(html?|css|scss|sass|less)$/i, label: "WEB", tone: "border-orange-300 bg-orange-100 text-orange-900 dark:border-orange-700 dark:bg-orange-950/70 dark:text-orange-100" },
	{ match: /\.(sh|bash|zsh|fish|ps1)$/i, label: "SH", tone: "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100" },
	{ match: /\.(rs|go|java|kt|swift|c|cc|cpp|cxx|h|hpp|rb)$/i, label: "CODE", tone: "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-700 dark:bg-sky-950/70 dark:text-sky-100" },
];

function fileTone(name: string, mimeType?: string) {
	const haystack = `${name}\n${mimeType ?? ""}`;
	return FILE_TYPE_TONES.find((t) => t.match.test(haystack)) ?? {
		label: (name.split(".").pop() || "FILE").toUpperCase().slice(0, 4),
		tone: "border-stone-300 bg-stone-100 text-stone-800 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100",
	};
}

export function FileAttachmentIcon({
	name,
	mimeType,
	className,
}: {
	name: string;
	mimeType?: string;
	className?: string;
}) {
	const pick = fileTone(name, mimeType);
	return (
		<div
			className={cn(
				"relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[9px] font-bold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]",
				pick.tone,
				className,
			)}
			title={mimeType || name}
		>
			<span className="pointer-events-none absolute right-0 top-0 h-2 w-2 rounded-bl border-b border-l border-current/20 bg-white/45 dark:bg-white/10" />
			<span className="relative z-10 max-w-full truncate px-0.5">{pick.label}</span>
		</div>
	);
}
