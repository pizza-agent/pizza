/** Fixed Google API identities shared by the desktop adapters and the OAuth broker. */
export const PIZZA_GOOGLE_BROKER_ISSUER = "https://pizza.hertzbeat.com/oauth/google";
export const PIZZA_GOOGLE_BROKER_CLIENT_ID = "pizza-desktop-google";
export type GoogleApiProduct = "gmail" | "drive" | "docs" | "sheets" | "slides" | "calendar" | "chat" | "people";
export interface GoogleApiService {
	product: GoogleApiProduct;
	name: string;
	adapter: string;
	resource: string;
	description: string;
	docsUrl: string;
	scopes: readonly string[];
	authCheck?: { tool: string; arguments?: Record<string, unknown> };
	note?: string;
}
const scope = (...names: string[]) => names.map(name => `https://www.googleapis.com/auth/${name}`);
/** Official Workspace MCP preview resource → allowed scopes, for saved-config compatibility (broker allowlist and legacy catalog entries). */
export const LEGACY_GOOGLE_WORKSPACE_RESOURCES = {
	"https://gmailmcp.googleapis.com/mcp/v1": scope("gmail.readonly", "gmail.compose"),
	"https://drivemcp.googleapis.com/mcp/v1": scope("drive.readonly", "drive.file"),
	"https://docsmcp.googleapis.com/mcp/v1": scope("drive.readonly", "drive.file", "documents.readonly", "documents"),
	"https://sheetsmcp.googleapis.com/mcp/v1": scope("drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets"),
	"https://slidesmcp.googleapis.com/mcp/v1": scope("drive.readonly", "drive.file", "presentations.readonly", "presentations"),
	"https://calendarmcp.googleapis.com/mcp/v1": scope("calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly"),
	"https://chatmcp.googleapis.com/mcp/v1": scope("chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create", "chat.users.readstate", "chat.users.spacesettings"),
	"https://people.googleapis.com/mcp/v1": scope("directory.readonly", "userinfo.profile", "contacts.readonly"),
} as const;
export const GOOGLE_API_SERVICES: readonly GoogleApiService[] = [
	{ product: "gmail", name: "gmail", adapter: "gmail", resource: "https://gmail.googleapis.com/gmail/v1/users/me",
		description: "Search emails, read conversations, and prepare drafts and replies.", docsUrl: "https://developers.google.com/workspace/gmail/api/guides",
		scopes: scope("gmail.readonly", "gmail.compose"), authCheck: { tool: "list_labels" } },
	{ product: "drive", name: "google-drive", adapter: "google-drive", resource: "https://www.googleapis.com/drive/v3",
		description: "Search Drive files, read and export content, and create or update files.", docsUrl: "https://developers.google.com/workspace/drive/api/guides/about-sdk",
		scopes: scope("drive.readonly", "drive.file"), authCheck: { tool: "get_profile" } },
	{ product: "docs", name: "google-docs", adapter: "google-docs", resource: "https://docs.googleapis.com/v1/documents",
		description: "Find, read, create, and edit Google Docs.", docsUrl: "https://developers.google.com/workspace/docs/api/how-tos/overview",
		scopes: scope("drive.readonly", "documents"), authCheck: { tool: "list_documents", arguments: { page_size: 1 } } },
	{ product: "sheets", name: "google-sheets", adapter: "google-sheets", resource: "https://sheets.googleapis.com/v4/spreadsheets",
		description: "Find spreadsheets, read and write cells, and manage sheets.", docsUrl: "https://developers.google.com/workspace/sheets/api/guides/concepts",
		scopes: scope("drive.readonly", "spreadsheets"), authCheck: { tool: "list_spreadsheets", arguments: { page_size: 1 } } },
	{ product: "slides", name: "google-slides", adapter: "google-slides", resource: "https://slides.googleapis.com/v1/presentations",
		description: "Find, read, create, and edit Google Slides presentations.", docsUrl: "https://developers.google.com/workspace/slides/api/guides/overview",
		scopes: scope("drive.readonly", "presentations"), authCheck: { tool: "list_presentations", arguments: { page_size: 1 } } },
	{ product: "calendar", name: "google-calendar", adapter: "google-calendar", resource: "https://www.googleapis.com/calendar/v3",
		description: "Read calendars and availability, and create or update events.", docsUrl: "https://developers.google.com/workspace/calendar/api/guides/overview",
		scopes: scope("calendar.calendarlist.readonly", "calendar.events", "calendar.events.freebusy"), authCheck: { tool: "list_calendars", arguments: { page_size: 1 } } },
	{ product: "chat", name: "google-chat", adapter: "google-chat", resource: "https://chat.googleapis.com/v1",
		description: "Find Chat spaces, read messages, and send messages on request.", docsUrl: "https://developers.google.com/workspace/chat/api/guides",
		scopes: scope("chat.spaces.readonly", "chat.messages.readonly", "chat.messages.create"),
		authCheck: { tool: "list_spaces", arguments: { page_size: 1 } }, note: "Google Chat requires a configured Chat app in the publisher's project and an account with access to Chat." },
	{ product: "people", name: "google-people", adapter: "google-people", resource: "https://people.googleapis.com/v1",
		description: "Look up your Google profile, search contacts, and read contact details.", docsUrl: "https://developers.google.com/people",
		scopes: scope("userinfo.profile", "contacts.readonly"), authCheck: { tool: "get_profile" } },
];
export function googleApiServiceForResource(url: string): GoogleApiService | undefined {
	if (!URL.canParse(url)) return undefined;
	return GOOGLE_API_SERVICES.find(service => new URL(service.resource).href === new URL(url).href);
}
export function googleApiService(config: { url?: unknown; adapter?: unknown }): GoogleApiService | undefined {
	const service = typeof config.url === "string" ? googleApiServiceForResource(config.url) : undefined;
	return service?.adapter === config.adapter ? service : undefined;
}
export function googleApiOAuth(service: GoogleApiService) {
	return { clientName: "Pizza", clientId: PIZZA_GOOGLE_BROKER_CLIENT_ID, resourceIndicator: true, requireSignIn: true,
		scope: service.scopes.join(" "), authServerMetadataUrl: `${PIZZA_GOOGLE_BROKER_ISSUER}/.well-known/oauth-authorization-server`,
		resourceMetadataUrl: `${PIZZA_GOOGLE_BROKER_ISSUER}/resources/${service.product}`, ...(service.authCheck ? { authCheck: service.authCheck } : {}) };
}
export function googleApiCatalogEntries() {
	return GOOGLE_API_SERVICES.map(service => ({ name: service.name, type: "http" as const, description: service.description, docsUrl: service.docsUrl,
		connectionNote: service.note ?? "Connect with your Google account. No app credentials are needed.",
		config: { url: service.resource, adapter: service.adapter, description: service.description, oauth: googleApiOAuth(service) } }));
}
