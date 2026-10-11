/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pizza -p "prompt"` - text output
 * - `pizza --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "../core/agent/types.js";
import type { ImageContent as EventImageContent } from "../core/event-store/types.js";
import { flushRawStdout, writeRawStdout } from "../core/exec/output-guard.js";
import type { SessionFacade } from "../core/session/session-facade.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

function registerPrintModeSignalHandlers(disposeRuntime: () => Promise<void>): Array<() => void> {
	const cleanupHandlers: Array<() => void> = [];
	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			void disposeRuntime().finally(() => {
				process.exit(signal === "SIGHUP" ? 129 : 143);
			});
		};
		process.on(signal, handler);
		cleanupHandlers.push(() => process.off(signal, handler));
	}

	return cleanupHandlers;
}

function writeFinalAssistantText(messages: AgentMessage[]): number {
	const lastMessage = messages[messages.length - 1];
	if (lastMessage?.role !== "assistant") {
		return 0;
	}

	const assistantMsg = lastMessage as AssistantMessage;
	if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
		console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		return 1;
	}

	for (const content of assistantMsg.content) {
		if (content.type === "text") {
			writeRawStdout(`${content.text}\n`);
		}
	}

	return 0;
}

function toEventImages(images?: ImageContent[]): EventImageContent[] | undefined {
	if (!images) return undefined;
	return images.map((image) => {
		const eventImage = image as ImageContent & { mime_type?: string };
		return {
			type: "image",
			data: image.data,
			mime_type: eventImage.mime_type ?? image.mimeType,
		};
	});
}

/**
 * Run print mode against the event-sourced facade.
 * JSON mode emits raw TypedEvent JSON lines; text mode prints the final assistant text.
 */
export async function runPrintModeWithFacade(facade: SessionFacade, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await Promise.resolve(facade.dispose());
	};

	const signalCleanupHandlers = registerPrintModeSignalHandlers(disposeRuntime);

	try {
		unsubscribe = facade.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});

		if (initialMessage) {
			await facade.prompt(initialMessage, toEventImages(initialImages));
		}

		for (const message of messages) {
			await facade.prompt(message);
		}

		if (mode === "text") {
			exitCode = writeFinalAssistantText(facade.getProjection().buildContext().messages);
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
