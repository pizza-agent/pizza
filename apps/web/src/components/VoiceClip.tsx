/**
 * Voice clip chip — play/pause + duration + transcript, rendered inside
 * channel-message cards for `<voice …/>` segments. The audio file lives in
 * the gateway's voice-cache dir and is read through the Tauri bridge
 * (`read_voice_clip`, path-checked under voice-cache/).
 */

import { useEffect, useRef, useState } from "react";
import { Play, Pause, AudioLines, Loader2 } from "lucide-react";
import { isTauri } from "@/lib/platform";
import type { VoiceClip } from "@/lib/agent-messages";
import { cn } from "@/lib/utils";

function base64ToBlob(b64: string, mime: string): Blob {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

/** Guess a playable MIME type for the cached file extension. Opus from Lark
 *  needs an ogg container hint for <audio>; telegram's oga is already ogg. */
function mimeFor(file: string): string {
	const ext = file.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "opus":
			return "audio/ogg; codecs=opus";
		case "oga":
		case "ogg":
			return "audio/ogg";
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "m4a":
		case "mp4":
			return "audio/mp4";
		default:
			return "audio/*";
	}
}

export function VoiceClipChip({ clip }: { clip: VoiceClip }) {
	const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const urlRef = useRef<string | null>(null);

	useEffect(() => {
		return () => {
			audioRef.current?.pause();
			if (urlRef.current) URL.revokeObjectURL(urlRef.current);
		};
	}, []);

	const toggle = async () => {
		if (!clip.file || !isTauri()) return;
		if (state === "playing") {
			audioRef.current?.pause();
			setState("idle");
			return;
		}
		if (audioRef.current) {
			void audioRef.current.play();
			setState("playing");
			return;
		}
		setState("loading");
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const b64 = await invoke<string>("read_voice_clip", { relPath: clip.file });
			const url = URL.createObjectURL(base64ToBlob(b64, mimeFor(clip.file)));
			urlRef.current = url;
			const audio = new Audio(url);
			audio.onended = () => setState("idle");
			audio.onerror = () => setState("error");
			audioRef.current = audio;
			void audio.play();
			setState("playing");
		} catch {
			setState("error");
		}
	};

	const playable = Boolean(clip.file) && isTauri();
	const duration = clip.durationS !== undefined ? `${Math.round(clip.durationS)}s` : undefined;

	return (
		<div className="flex flex-col gap-1">
			<div
				className={cn(
					"inline-flex w-fit items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1.5 text-xs",
					playable && "cursor-pointer hover:border-fg/30",
					state === "error" && "border-red-500/40 text-red-400",
				)}
				onClick={playable ? toggle : undefined}
				title={playable ? "Play voice clip" : clip.file ? "Playback requires the desktop app" : "Clip not available"}
			>
				{state === "loading" ? (
					<Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
				) : state === "playing" ? (
					<Pause className="h-3.5 w-3.5 text-fg" />
				) : (
					<Play className={cn("h-3.5 w-3.5", playable ? "text-fg" : "text-muted")} />
				)}
				<AudioLines className="h-3.5 w-3.5 text-muted" />
				<span className="text-muted">{duration ? `voice · ${duration}` : "voice"}</span>
			</div>
			{clip.transcript && <div className="whitespace-pre-wrap break-words">{clip.transcript}</div>}
		</div>
	);
}
