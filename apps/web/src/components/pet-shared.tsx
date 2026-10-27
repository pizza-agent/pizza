/**
 * pet-shared.tsx — pet UI shared by the floating window (pet.tsx) and the
 * settings page (PetSettingsPage): the chat pill and shared chip styles.
 * Built-in pet artwork lives in pet-sprites.tsx (re-exported here).
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";

export { PetSprite, SPECIES, type PetSpriteProps } from "./pet-sprites";

export type { PetMood as Mood } from "@/lib/pet";

// --- chat pill (input + round record button) --------------------------------

export function PetChatPill({
	input,
	setInput,
	onSend,
	onTranscribe,
	voice = true,
	autoFocus = true,
	sending = false,
	error = "",
	sent = false,
	onActive,
}: {
	input: string;
	setInput: (v: string) => void;
	onSend: () => void;
	/** Transcribe recorded audio — provided by the host (Tauri transcribe_audio). */
	onTranscribe?: (audioB64: string, mimeType: string) => Promise<string>;
	voice?: boolean;
	autoFocus?: boolean;
	sending?: boolean;
	error?: string;
	sent?: boolean;
	onActive?: () => void;
}) {
	const [voiceError, setVoiceError] = useState("");
	const [starting, setStarting] = useState(false);
	const mountedRef = useRef(true);
	const inputValueRef = useRef(input);
	inputValueRef.current = input;
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
		if (!onTranscribe || starting || transcribing || sending) return;
		onActive?.();
		setVoiceError("");
		setStarting(true);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!mountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
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
					if (typeof result !== "string" || !mountedRef.current) return;
					const b64 = result.slice(result.indexOf(",") + 1);
					setTranscribing(true);
					try {
						const text = await onTranscribe(b64, mimeRef.current);
						if (text && mountedRef.current) setInput((inputValueRef.current ? inputValueRef.current.trimEnd() + " " : "") + text);
					} catch (e) {
						if (mountedRef.current) setVoiceError(String(e));
					} finally {
						if (mountedRef.current) setTranscribing(false);
					}
				};
				reader.readAsDataURL(blob);
			};
			recorderRef.current = rec;
			setRecording(true);
			rec.start(250);
		} catch (e) {
			stopStream();
			setRecording(false);
			setVoiceError(String(e));
		}
		finally { if (mountedRef.current) setStarting(false); }
	};

	const stopRecording = () => {
		recorderRef.current?.stop();
		recorderRef.current = null;
		setRecording(false);
	};

	useEffect(() => {
		mountedRef.current = true;
		return () => {
		mountedRef.current = false;
		if (recorderRef.current) {
			recorderRef.current.onstop = null;
			if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
		}
		streamRef.current?.getTracks().forEach((track) => track.stop());
		};
	}, []);

	return (
		<div data-nodrag style={{ maxWidth: "100%", width: 256 }} onFocus={onActive}>
			<div style={{ ...chatBarStyle, marginBottom: 5 }}>
			<style>{"@keyframes petRecPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(229,72,77,.55); } 50% { box-shadow: 0 0 0 5px rgba(229,72,77,0); } }"}</style>
			<input
				ref={inputRef}
				value={transcribing ? "transcribing…" : input}
				disabled={transcribing || sending}
				aria-label="Message main assistant"
				placeholder={recording ? "Listening…" : "Message main…"}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing && !recording && !sending && !transcribing && !starting) { e.preventDefault(); onSend(); }
					if (e.key === "Escape") setInput("");
					e.stopPropagation();
				}}
				style={chatInputStyle}
			/>
			{voice && onTranscribe && (
				<button
					type="button"
					aria-label={recording ? "Stop recording" : "Record voice"}
					disabled={starting || transcribing || sending}
					title={recording ? "Stop & transcribe" : "Record voice"}
					onClick={() => (recording ? stopRecording() : void startRecording())}
					style={{
						...recButtonStyle,
						background: recording ? "#e5484d" : "rgba(255,255,255,0.16)",
						animation: recording ? "petRecPulse 1.1s ease-in-out infinite" : undefined,
					}}
				>
					{recording ? <Square size={12} /> : transcribing || starting ? "…" : <Mic size={14} />}
				</button>
			)}
			<button type="button" aria-label="Send to main assistant" title="Send to main assistant" disabled={!input.trim() || sending || recording || transcribing || starting} onClick={onSend} style={{ ...recButtonStyle, color: input.trim() && !sending ? "#b8efda" : "#88918e", background: "rgba(255,255,255,.1)" }}><ArrowUp size={15} /></button>
			</div>
			<div role={error || voiceError ? "alert" : "status"} style={{ maxHeight: 42, overflowY: "auto", fontSize: 10, lineHeight: 1.3, textAlign: "center", color: error || voiceError ? "#ffb3b5" : "#e8f4e8", background: "rgba(16,20,24,.8)", borderRadius: 8, padding: "3px 6px", overflowWrap: "anywhere" }}>
				{error || voiceError || (sending ? "Sending to main…" : sent ? "Sent · Continue in main" : "main assistant · Enter to send")}
			</div>
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
	width: 0,
	minWidth: 0,
	flex: 1,
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
