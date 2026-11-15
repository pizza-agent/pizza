# Google API OAuth broker

Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat and People use stable Google APIs behind local Pizza MCP adapters, with Pizza's hosted Web OAuth registration. End users install a product and sign in; they do not enter a Google client ID or client secret. Official Workspace MCP preview entries are no longer offered in the marketplace; saved advanced configurations remain compatible.

## Publisher setup

1. Enable the selected regular APIs in the publisher's Google Cloud project: `gmail.googleapis.com`, `drive.googleapis.com`, `docs.googleapis.com`, `sheets.googleapis.com`, `slides.googleapis.com`, `calendar-json.googleapis.com`, `chat.googleapis.com` and `people.googleapis.com`. No Workspace MCP preview enrollment is needed. Google Chat additionally requires a configured Chat app and account access; administrator policies still apply.
2. Configure the consent screen and product scopes in `src/builtin-extensions/connectors/google-services.ts`. During testing, add the real sign-in account as a test user. Public distribution may require Google verification for the requested scopes.
3. Create a **Web application** OAuth client and enable **Use this client for an AI-powered agent**. Register this exact HTTPS redirect URI:

   `https://pizza.hertzbeat.com/oauth/google/callback`

4. Download the Web client JSON outside the repository. Do not paste the secret into chat, source files or command arguments. With Node 22.12+ and Wrangler already logged in, import it directly into Cloudflare secrets:

   ```sh
   node infra/mcp-oauth/configure-google.mjs /absolute/path/to/google-web-client.json
   ```

   The importer validates the Web client format and uploads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. It generates `GOOGLE_TOKEN_KEY` only if no key exists. Existing encryption keys are retained. Older downloads can predate a callback change; the importer reminds you to verify the live Console configuration when the JSON does not list the broker callback. The Web secret is never bundled in desktop or web builds. Keep the downloaded JSON private.

5. Check and deploy from `infra/mcp-oauth`:

   ```sh
   npm run check
   npm run test:runtime
   npm run deploy
   curl --fail https://pizza.hertzbeat.com/oauth/google/health
   ```

   A ready deployment returns `{"configured":true,...}`. A deployment without all secrets/bindings returns 503 and refuses authorization. The public CIMD documents continue to return 200.

`GOOGLE_TOKEN_KEY` is an AES-256 key encoded as 64 hexadecimal characters. Preserve it in your secret-management process. Replacing it invalidates existing broker sessions and requires a fresh login. Changing the Google client ID also requires reauthorization. Rotating the Google secret for the same client ID does not change the encrypted token key.

## Authorization and credential lifetime

1. Desktop opens `/oauth/google/authorize` with its public client ID `pizza-desktop-google`, random state, S256 PKCE challenge, exact MCP resource and product scopes.
2. Worker validates the resource/scope allowlist from the shared connector catalog and an explicit-port `http://127.0.0.1:<port>/callback` redirect. It creates an isolated Durable Object with a ten-minute pending login, binds the browser using a Secure/HttpOnly/SameSite cookie, and starts a separate Google PKCE flow. Google receives the registered HTTPS callback, `access_type=offline` and `prompt=consent`.
3. Worker validates the callback state and browser cookie, consumes the pending attempt, and exchanges the Google code using the publisher's secret. Incomplete permissions or missing offline access fail the login. The Worker redirects to the local desktop with a new single-use code, original desktop state and Pizza issuer. No Google credential appears in that URL.
4. Desktop redeems that code within one minute with its original PKCE verifier, exact callback, client ID and MCP resource. The response contains a Google access token and an opaque Pizza refresh handle. The raw Google refresh token and ID token are never returned to the desktop. API traffic then goes directly from the local MCP adapter to Google's fixed product API endpoint.
5. Refresh verifies the opaque handle and resource, calls Google's fixed token endpoint and atomically rotates the Pizza handle. Requests for the same login are serialized across network waits; concurrent reuse yields one success. Credentials are encrypted with AES-GCM at rest, authenticated to the session ID. An alarm deletes abandoned attempts, unredeemed codes and grants idle for 180 days.

Broker tokens are bearer credentials; the desktop stores them using its existing credential store and refresh lock. Local sign-out removes desktop credentials; Google account access can be revoked in Google account settings. This implementation does not claim that local sign-out revokes Google's entire app grant, which may be shared by other connected products. A lost response after a consumed code or refresh handle can require a fresh login.

## Boundaries and checks

- Fixed canonical HTTPS origin and Google endpoints; no user-supplied upstream URLs, arbitrary redirects, dynamic clients, client secrets in redirects or CORS token access.
- Exact resource binding and product-specific scopes on authorization, redemption and refresh. Google tokens may be valid for several APIs, but the broker never changes the resource attached to a grant.
- Responses use no-store/no-referrer, callbacks use browser state/cookie binding, and each authorization uses PKCE on both legs. Foreign issuers and duplicate parameters are rejected. Request sizes and per-IP request rates are bounded. Cloudflare request logging is disabled in this deployment; do not enable URL logging or dump token request bodies when debugging.
- `test/mcp-google-broker.test.ts` drives the actual desktop OAuth engine against a fixture upstream and covers expiry, denial, encryption, PKCE, refresh, replay and binding failures. `test-google-runtime.mjs` repeats the core chain in actual workerd with SQLite Durable Objects and fixture Google responses. Neither test authorizes a real Google account.

Real account completion still requires the publisher setup above, Google consent and a read-only MCP call. Anonymous tool-schema discovery does not prove access to account data.

## Real-account verification, 2026-11-15

- Completed browser consent, Google-to-Cloudflare callback, single-use desktop handoff, PKCE redemption and local credential persistence with the publisher's Web registration.
- Forced local token expiry and exercised the actual broker refresh endpoint: Google access was refreshed, the opaque handle rotated and the issuer/resource binding remained unchanged. No application secret or raw Google refresh token was returned to desktop.
- The publisher project initially had Drive API and Drive MCP API disabled. Enabled both through Google Console. Afterwards authenticated initialize and tools/list succeeded with eight tools; a minimal ordinary Drive REST read succeeded with HTTP 200.
- The official MCP `list_recent_files` request still returned `isError: true` with `The caller does not have permission`. The publisher's Developer Preview enrollment is not confirmed. OAuth success and tool discovery therefore do **not** establish working MCP data access. Drive now performs a one-item, metadata-only read check before reporting a usable connection.
- The user chose stable APIs instead of applying for Preview enrollment. The application form was closed without submission. These historical official-MCP results do not describe the new local adapter's verification status.

## Local tools and resource metadata

The marketplace contains eight Google products and 55 tools: Gmail 11, Drive 11, Docs 4, Sheets 8, Slides 5, Calendar 7, Chat 5 and People 4. Gmail prepares drafts rather than sending mail. Calendar notifications default to none. Chat sending is an explicit write tool. Batch updates may alter or delete content and are annotated accordingly.

`/oauth/google/resources/{product}` publishes protected-resource metadata for the exact stable API resource and the Pizza issuer. Desktop uses this endpoint for discovery instead of probing Google business APIs for MCP discovery. The broker permits the stable resources and legacy official-MCP resources independently; switching a saved connection from an official MCP resource to a local API adapter requires a new login. Credentials are never rebound to a different resource.

All local adapters validate arguments, restrict outgoing hosts, bound requests/responses, paginate list tools and refresh once after 401. They do not replay writes after 403, 429 or server errors. Document and message contents are untrusted data. `test/google-api-adapter.test.ts` exercises all 44 new tools with the actual MCP client and simulated API responses; Gmail has its existing 11-tool suite. These fixtures do not establish account-specific access for untested products.

## Stable API real-account verification, 2026-11-15

- Enabled Gmail, Docs, Sheets, Slides, Calendar, Chat and People APIs in `pizza-agent-513315`; Drive API was already enabled. No Preview application was submitted.
- Deployed stable resource metadata and the OAuth allowlist to `pizza.hertzbeat.com` (deployment `bf850d96-22dd-408d-a781-48b57081f95a`).
- Replaced the DEV Drive connection with the local API adapter and completed fresh browser authorization for the exact `https://www.googleapis.com/drive/v3` resource. Existing official-MCP credentials were not rebound.
- DEV reported the real profile check successful and exposed 11 tools. `_agentcli google-drive list_recent_files --page_size 1` returned one file successfully; file names and IDs were not copied into this report.
- Forced local token expiry and repeated the read through DEV: actual Google access refreshed, the opaque broker handle rotated, and issuer/resource remained bound. Expiry was approximately 3600 seconds.
- Stopped the idle DEV gateway, reconnected from desktop and repeated the read successfully. Notion remained connected with 77 tools.
- Other products have protocol/API fixture coverage, not a real-account completion claim. Google Chat still needs its publisher app configuration and a supported account. Public OAuth distribution remains subject to Google's normal verification and account policies.

Ten fictional, frozen, read-only multi-call evaluation scenarios are in `test/fixtures/mcp/google-api/evaluation.xml`, with executable fixtures in the adjacent JSON and `test/google-api-evaluation.test.ts`. They cover retrieval and follow-up reads without accessing personal data.
