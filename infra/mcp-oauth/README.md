# Pizza MCP OAuth client metadata

Public endpoint: `https://pizza.hertzbeat.com/oauth/client.json`.

CIMD lets an MCP authorization server read Pizza's client identity from this URL instead of registering a new client. This service publishes public JSON only. It has no login page, token exchange, database, client secret, or user credentials.

## Deploy to Cloudflare Workers

The Worker is named `pizza-mcp-oauth-metadata`. Its Wrangler configuration binds the custom domain `pizza.hertzbeat.com`. Cloudflare provisions the DNS binding and HTTPS certificate for this Worker. The domain must belong to the account used by Wrangler.

Use Node.js 22.12 or later (for example, `nvm use 22.21.1`). From the repository root:

```sh
npm ci --prefix infra/mcp-oauth
npm exec --prefix infra/mcp-oauth -- wrangler login --device
npm run check --prefix infra/mcp-oauth
npm run deploy --prefix infra/mcp-oauth
```

Wrangler is pinned in this service's own package and lock file. No database, secrets or other Cloudflare products are required. The `workers.dev` hostname and preview URLs are disabled; OAuth client IDs use the canonical custom domain.

Device login opens Cloudflare in your default browser and prints a short confirmation code. Complete the login and approve Wrangler while the terminal is waiting. This flow does not use a localhost callback. Check the result with `npm exec --prefix infra/mcp-oauth -- wrangler whoami`.

For local development, run `npm run dev --prefix infra/mcp-oauth`. Both the Worker and the optional Node server below use the same request handler.

To update a deployment, rerun the check and deploy commands. To inspect or roll back deployments:

```sh
npm exec --prefix infra/mcp-oauth -- wrangler deployments list
npm exec --prefix infra/mcp-oauth -- wrangler rollback
```

## Optional Node deployment

Run the dependency-free metadata service with Node.js 22 or later:

```sh
node infra/mcp-oauth/server.mjs
```

It listens on `127.0.0.1:8788`. Point `pizza.hertzbeat.com` at your host, configure HTTPS, and proxy `/oauth/` to this service. For example, in an existing Nginx HTTPS virtual host:

```nginx
location /oauth/ {
    proxy_pass http://127.0.0.1:8788;
}
```

Keep the process running with your normal service manager. `PORT` and `MCP_OAUTH_METADATA_HOST` override the listener. When running in a container, set the latter to `0.0.0.0` and expose the port through your HTTPS proxy.

The service serves both forms:

| URL | Redirect path |
| --- | --- |
| `/oauth/client.json` | `/callback` |
| `/oauth/<callback-id>/client.json` | `/callback/<callback-id>` |

The shared document is used with authorization servers that advertise issuer identification. Others get a server-specific document and callback path. Callback IDs are the first 9 bytes of SHA-256 over the complete MCP URL without its fragment, encoded as base64url (12 characters). Redirect URIs omit ports; RFC 8252 permits the runtime-selected loopback port. Redirects go to the user's local Pizza process, never this metadata service.

`client.json` can also be hosted as a static file for servers with issuer identification. Supporting arbitrary server-specific IDs requires the dynamic handler.

Verify both public routes return JSON without authentication, with `client_id` exactly matching the requested HTTPS URL. For example:

```sh
curl --fail https://pizza.hertzbeat.com/oauth/client.json
curl --fail https://pizza.hertzbeat.com/oauth/abcdefghijkl/client.json
```

## Client behavior

Pizza defaults to `oauth.clientRegistration: "auto"`. A configured `clientId` takes precedence. Otherwise, if the authorization server supports public-client CIMD and Pizza's metadata document is available, Pizza uses CIMD; it falls back to DCR if the document is unavailable. Invalid identity/redirect contents fail the login. DCR remains necessary for older providers. Neither method replaces the user's browser consent.

`oauth.clientRegistration: "cimd"` requires CIMD and reports deployment/support errors. `"dcr"` forces DCR. `oauth.clientMetadataUrl`, or `PIZZA_MCP_OAUTH_CLIENT_METADATA_URL`, can override the default document family for another Pizza deployment. It must end in `/client.json`; deploy both document forms at the same base path.

Legacy saved logins without an issuer/client binding require one new login after upgrading. Credentials remain on the user's machine. Google/X/GitHub business OAuth and device flow retain their provider-specific registrations.

Explicit sign-in starts a fresh browser authorization, so re-authentication and account switching do not silently reuse an existing refresh token. A new sign-in or sign-out invalidates earlier operations. Refresh tokens are rotated under a cross-process lock, and token writes check that the request still belongs to the active login.

Standard MCP requests include the RFC 8707 resource in authorization and token requests, including legacy discovery without resource metadata. `oauth.resourceIndicator: false` is an explicit compatibility setting for direct business APIs such as the Gmail REST adapter. `authorizationResourceIndicator: false` omits it only in the browser authorization request, preserving token audience binding.

## Verify the client and service

From the repository root:

```sh
npm test -- test/mcp-oauth2.test.ts test/mcp-oauth-http.test.ts test/mcp-oauth-cloudflare.test.ts
PIZZA_MCP_LIVE_METADATA=1 npm test -- test/mcp-oauth-http.test.ts
npm run build
```

The HTTP suite runs a local MCP resource/authorization server that independently checks PKCE, client/redirect/resource binding and single-use codes. It exercises browser callbacks, persistent credentials, refresh rotation, restart, scope step-up and sign-out for CIMD and DCR. The opt-in live test reads the published Cloudflare metadata; all authorization and tool calls still use the local fixture. It does not sign in to a real provider account or access user data.
