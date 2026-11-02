/** Serializable interaction primitives shared by all agents and clients. */
export interface InteractionOption {
	id: string;
	label: string;
	description?: string;
}
export interface InteractionField {
	id: string;
	type: "text" | "select" | "multi";
	label: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
	options?: InteractionOption[];
}
export interface InteractionAction {
	id: string;
	label: string;
	capabilityId?: string;
}
export interface InteractionCard {
	/** An unsolicited suggestion; main-agent policy gates creation. */
	initiative?: boolean;
	title: string;
	description?: string;
	fields?: InteractionField[];
	actions?: InteractionAction[];
	allowSkip?: boolean;
	submitLabel?: string;
	expiresInMinutes?: number;
}
export type InteractionAnswer =
	| { kind: "submit"; values: Record<string, string | string[]>; actionId?: string }
	| { kind: "text"; text: string }
	| { kind: "skip" };
export interface InteractionCapability {
	id: string;
	label: string;
	description: string;
	status: string;
	/** Instructions supplied by the registered capability, never executable UI code. */
	instructions: string;
}
export interface InteractionRecord {
	id: string;
	toolCallId: string;
	card: InteractionCard;
	createdAt: number;
	expiresAt: number;
	status: "pending" | "answered" | "skipped" | "expired";
	capabilities: InteractionCapability[];
	answer?: InteractionAnswer;
}
