# Official OAuth connectors

Reviewed on 2026-11-15. The built-in MCP marketplace offers 45 entries. Installing a connector stores its configuration; users authorize each account in their browser. Entries are never connected automatically on startup.

| Connector | Setup | Source |
| --- | --- | --- |
| notion | Automatic CIMD / DCR | [Official documentation](https://developers.notion.com/docs/mcp) |
| github | Public device OAuth | [Official documentation](https://github.com/github/github-mcp-server) |
| gmail | Bundled adapter OAuth | [Official documentation](https://developers.google.com/workspace/gmail/api/guides) |
| x | Registered product OAuth | [Official documentation](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) |
| linear | Automatic CIMD / DCR | [Official documentation](https://linear.app/docs/mcp) |
| atlassian | Automatic CIMD / DCR | [Official documentation](https://github.com/atlassian/atlassian-mcp-server) |
| gitlab | Automatic CIMD / DCR | [Official documentation](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| sentry | Automatic CIMD / DCR | [Official documentation](https://mcp.sentry.dev/) |
| cloudflare | Automatic CIMD / DCR | [Official documentation](https://github.com/cloudflare/mcp) |
| vercel | Automatic CIMD / DCR | [Official documentation](https://vercel.com/docs/agent-resources/vercel-mcp) |
| netlify | Automatic CIMD / DCR | [Official documentation](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/) |
| supabase | Automatic CIMD / DCR | [Official documentation](https://supabase.com/docs/guides/ai-tools/mcp) |
| neon | Automatic CIMD / DCR | [Official documentation](https://neon.com/docs/ai/neon-mcp-server) |
| stripe | Automatic CIMD / DCR | [Official documentation](https://docs.stripe.com/mcp) |
| todoist | Automatic CIMD / DCR | [Official documentation](https://developer.todoist.com/api/v1/#tag/Todoist-MCP) |
| airtable | Automatic CIMD / DCR | [Official documentation](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server) |
| monday | Automatic CIMD / DCR | [Official documentation](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration) |
| clickup | Automatic CIMD / DCR | [Official documentation](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server) |
| intercom | Automatic CIMD / DCR | [Official documentation](https://developers.intercom.com/docs/guides/mcp) |
| intercom-eu | Automatic CIMD / DCR | [Official documentation](https://www.intercom.com/help/en/articles/11461635-add-mcp-connectors-for-popular-apps-or-custom-mcps) |
| amplitude | Automatic CIMD / DCR | [Official documentation](https://amplitude.com/docs/amplitude-ai/amplitude-mcp) |
| amplitude-eu | Automatic CIMD / DCR | [Official documentation](https://www.amplitude.com/docs/amplitude-ai/amplitude-mcp/other-clients) |
| posthog | Automatic CIMD / DCR | [Official documentation](https://posthog.com/docs/model-context-protocol/vscode) |
| webflow | Automatic CIMD / DCR | [Official documentation](https://developers.webflow.com/mcp/reference/getting-started) |
| asana | Own OAuth app required | [Official documentation](https://developers.asana.com/docs/integrating-with-asanas-mcp-server) |
| hubspot | Own OAuth app required | [Official documentation](https://developers.hubspot.com/ai-tools/mcp) |
| slack | Own OAuth app required | [Official documentation](https://docs.slack.dev/ai/slack-mcp-server/) |
| box | Own OAuth app required | [Official documentation](https://developer.box.com/guides/box-mcp/setup) |
| dropbox | Own OAuth app required | [Official documentation](https://help.dropbox.com/integrations/connect-dropbox-mcp-server) |
| canva | Own OAuth app required | [Official documentation](https://www.canva.dev/docs/apps/mcp/access/) |
| zoom | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-meetings | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-docs | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-chat | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-tasks | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-whiteboard | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |
| zoom-revenue | Own OAuth app required | [Official documentation](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/) |

| gmail-workspace | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-drive | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-docs | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-sheets | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-slides | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-calendar | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-chat | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |
| google-people | Workspace preview / own AI-agent OAuth app | [Official documentation](https://developers.google.com/workspace/guides/configure-mcp-servers) |

## Compatibility details

- Airtable explicitly uses DCR: its official troubleshooting guide documents rejected CIMD callbacks.
- Box pins its official authorization-server metadata URL because the protected-resource document adds a trailing slash to its issuer. Generic issuer validation remains exact.
- GitLab DCR assigns public clients the none authentication method even though global discovery advertises secret methods. The registered client metadata controls its token authentication, following RFC 7591 section 3.2.1. Unsupported registered methods fail before any token request.
- Atlassian uses the current v2 HTTP endpoint. Retired SSE endpoints are not shipped.
- Intercom and Amplitude have separate EU entries. PostHog routes regions during sign-in.
- monday.com requires account administrator approval for additional clients. GitLab requires enabling MCP for a group or instance.
- Asana, HubSpot, Slack, Box, Dropbox, Canva and the Zoom product servers require user-supplied OAuth app credentials and an exact registered loopback callback. The setup dialog links to each service’s official guide. Credentials are never baked into the catalog. Slack requires an internal or Marketplace-published app. Dropbox restricts automatic registration to approved clients. Canva uses its documented developer endpoint, not the endpoint reserved for existing assistant integrations. Each Zoom entry is a separate product MCP server with its own scopes; one Zoom General OAuth app can cover several products.

## Verification

Build the backend, then run the anonymous, read-only network check:

```sh
npm run build
node scripts/check-mcp-oauth-catalog.mjs
```

It checks the 42 standard OAuth endpoints, including 13 registered-app entries and 8 Google Workspace preview entries, without browser login, client registration, account access, or local credentials. GitHub device flow, Gmail’s local adapter and X’s product registration are covered by their dedicated tests.

Public discovery responses are recorded in test/fixtures/mcp/official-oauth-discovery.json. The offline provider matrix tests client selection, callback state/issuer checks, code redemption, client authentication, resource binding and refresh rotation against these real metadata shapes with simulated account credentials. To refresh those public fixtures, run the checker with --record and the fixture path.

A separate pre-authorization smoke check reached the official authorization pages for all 20 new automatic-registration entries using Pizza’s actual CIMD service or live DCR. No accounts were authorized by that check. Notion additionally passed real-account consent, callback, tool discovery, read-only identity calls, refresh and restart recovery. The other providers still require account-level authorization to verify their tools end to end.

## Reviewed services with remaining requirements

- [Figma](https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server): remote access requires approving new clients. Pizza has no approved registration yet; another product’s client identity is never reused.
- [PayPal](https://developer.paypal.com/ai-tools/mcp-server): the documented production Streamable HTTP endpoint returned 404 during anonymous initialize and GET requests. Its discovery document alone is insufficient evidence of a working MCP endpoint, so it is not offered as a working connector.
- [Zoom](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/): product-specific MCP servers are offered as separate catalog entries, each requiring a manually registered General OAuth app, product licenses and scopes.
- Google Workspace preview entries are built in with their own AI-agent Web OAuth setup and product scopes. Their anonymous tool schemas do not prove account authorization, so requireSignIn prevents a connection without a token. The regular Gmail desktop adapter remains available separately. Google Classroom returned no tools in the anonymous catalog during this check and is not offered as a verified entry.
- Microsoft 365 needs product-specific OAuth registration and MCP endpoints or API adapters; Pizza’s CIMD identity alone does not provide Microsoft account access.

## Google, X and GitHub follow-up

See [provider-auth.md](./provider-auth.md) for the official-source review and live probes. GitHub requests offline_access on new installs and refreshes device-issued tokens without a client secret. X retains its Native public-client PKCE flow. Google Workspace previews require a user-registered AI-agent client; a public discovery response is not an authorized account.
