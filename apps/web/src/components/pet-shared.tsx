/**
 * pet-shared.tsx — pet visuals shared by the floating window (pet.tsx) and
 * the settings page (PetSettingsPage): the chat pill and shared chip styles.
 * Built-in pet artwork lives in pet-sprites.tsx (re-exported here).
 */

import { useEffect, useRef, useState } from "react";

export { PetSprite, SPECIES, type PetSpriteProps } from "./pet-sprites";

export type Mood = "idle" | "working" | "celebrating" | "happy" | "sad" | "sleepy" | "eating";

export interface PetMeta {
	species: string;
	name: string;
	level: number;
	xp?: number;
	mood: Mood;
	busy?: boolean;
	floating?: boolean | null;
	scale?: number;
	subtitle?: string;
}

/** Mirrors state.ts levelForXp so surfaces can label the pet from the raw save. */
export const levelForXp = (xp: number) => Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 10)) + 1);

// --- chat pill (input + round record button) --------------------------------

export function PetChatPill({
	input,
	setInput,
	onSend,
	onTranscribe,
	voice = true,
	autoFocus = true,
}: {
	input: string;
	setInput: (v: string) => void;
	onSend: () => void;
	/** Transcribe recorded audio — provided by the host (Tauri transcribe_audio). */
	onTranscribe?: (audioB64: string, mimeType: string) => Promise<string>;
	voice?: boolean;
	autoFocus?: boolean;
}) {
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const mimeRef = useRef("audio/webm");
	const streamRef = useRef<MediaStream | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus();
	}, [autoFocus]);

	const stopStream = () => {
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
	};

	const startRecording = async () => {
		if (!onTranscribe) return;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			streamRef.current = stream;
			const mime = MediaRecorder.isTypeSupported("audio/mp4")
				? "audio/mp4"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: "";
			const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
			mimeRef.current = rec.mimeType || mime || "audio/webm";
			chunksRef.current = [];
			rec.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data);
			};
			rec.onstop = () => {
				stopStream();
				const blob = new Blob(chunksRef.current, { type: mimeRef.current });
				chunksRef.current = [];
				if (blob.size === 0) return;
				const reader = new FileReader();
				reader.onload = async () => {
					const result = reader.result;
					if (typeof result !== "string") return;
					const b64 = result.slice(result.indexOf(",") + 1);
					setTranscribing(true);
					try {
						const text = await onTranscribe(b64, mimeRef.current);
						if (text) setInput((input ? input.trimEnd() + " " : "") + text);
					} catch (e) {
						console.error("transcribe failed:", e);
					} finally {
						setTranscribing(false);
					}
				};
				reader.readAsDataURL(blob);
			};
			recorderRef.current = rec;
			setRecording(true);
			rec.start(250);
		} catch (e) {
			console.error("mic failed:", e);
		}
	};

	const stopRecording = () => {
		recorderRef.current?.stop();
		recorderRef.current = null;
		setRecording(false);
	};

	useEffect(() => () => {
		if (recorderRef.current) {
			recorderRef.current.onstop = null;
			if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
		}
		streamRef.current?.getTracks().forEach((track) => track.stop());
	}, []);

	return (
		<div data-nodrag style={chatBarStyle}>
			<style>{"@keyframes petRecPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(229,72,77,.55); } 50% { box-shadow: 0 0 0 5px rgba(229,72,77,0); } }"}</style>
			<input
				ref={inputRef}
				value={transcribing ? "transcribing…" : input}
				disabled={transcribing}
				placeholder={recording ? "listening…" : "say something"}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") onSend();
					if (e.key === "Escape") setInput("");
					e.stopPropagation();
				}}
				style={chatInputStyle}
			/>
			{voice && onTranscribe && (
				<button
					type="button"
					title={recording ? "Stop & transcribe" : "Hold a thought, speak it"}
					onClick={() => (recording ? stopRecording() : void startRecording())}
					style={{
						...recButtonStyle,
						background: recording ? "#e5484d" : "rgba(255,255,255,0.16)",
						animation: recording ? "petRecPulse 1.1s ease-in-out infinite" : undefined,
					}}
				>
					{recording ? "■" : transcribing ? "…" : "●"}
				</button>
			)}
		</div>
	);
}

// --- shared styles ----------------------------------------------------------

export const petChipStyle: React.CSSProperties = {
	fontSize: 11,
	color: "#e8f4e8",
	background: "rgba(16,20,24,0.72)",
	borderRadius: 10,
	padding: "2px 10px",
	backdropFilter: "blur(6px)",
	border: "1px solid rgba(255,255,255,0.10)",
	whiteSpace: "nowrap",
};

export const petAsciiStyle: React.CSSProperties = {
	margin: "4px 0 0",
	fontSize: 11,
	lineHeight: 1.25,
	color: "#d4f7d4",
	background: "rgba(20,24,28,0.82)",
	borderRadius: 12,
	padding: "8px 12px",
};

const chatBarStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 5,
	marginTop: 2,
	padding: "4px 5px 4px 12px",
	borderRadius: 16,
	background: "rgba(16,20,24,0.85)",
	border: "1px solid rgba(255,255,255,0.14)",
	backdropFilter: "blur(10px)",
	boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
};

const chatInputStyle: React.CSSProperties = {
	width: 118,
	border: "none",
	outline: "none",
	background: "transparent",
	color: "#e8f4e8",
	fontSize: 12,
};

const recButtonStyle: React.CSSProperties = {
	width: 24,
	height: 24,
	borderRadius: 12,
	border: "none",
	color: "#ffb3b5",
	fontSize: 10,
	cursor: "pointer",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: 0,
};
