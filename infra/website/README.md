# Pizza website

Public website: https://pizza.hertzbeat.com/ (English), https://pizza.hertzbeat.com/zh/ (Chinese).

The site lives here; the existing `../mcp-oauth` Cloudflare Worker owns the domain and serves the built assets. All `/oauth` paths run through the existing OAuth handlers before asset routing. No OAuth secrets, account tokens, or local configuration are copied into the site. Static paths use real 404 responses rather than a universal app shell.

## Local preview and deployment

Use Node 22.21 or later:

```sh
npm ci --prefix infra/website
npm ci --prefix infra/mcp-oauth
npm run build --prefix infra/website
npm run preview --prefix infra/website
# Preview: http://127.0.0.1:4175/

npm run refresh:release --prefix infra/website
npm run check --prefix infra/mcp-oauth
npm run test:runtime --prefix infra/mcp-oauth
npm run deploy --prefix infra/website
```

Wrangler builds the site automatically before deployment. The deploy command uses the existing authenticated Cloudflare CLI and retains the Worker's existing secrets, Durable Objects, rate limiter, domain, and logging settings. A fresh checkout needs dependencies in both directories. `refresh:release` fetches only public GitHub release data, validates the official repository's asset URLs, and updates `src/release.json`. Builds otherwise work without a GitHub token or network lookup.

After deployment, check `/`, `/zh/`, the stylesheet, video, favicon, `/oauth/client.json`, `/oauth/google/health`, and `/oauth/google/resources/drive`. Unknown `/oauth` paths must remain errors, never website HTML.

## Design and content

Editorial desktop-product direction: variance 7, motion 4, density 3. Brand orange, Manrope, a single light/dark token system, and real product media. Native CSS with Tailwind v4's base; React is pre-rendered at build time for both languages. JavaScript hydrates the demo dialog, theme switch, mobile navigation, reveal transitions, and clipboard control. Motion respects reduced-motion preferences. Fonts and media are hosted on the same origin. No analytics, third-party scripts, forms, or tracking cookies are included.

Download links reflect the latest public release when `refresh:release` was last run. The FAQ states platform architecture and provider/model costs. App availability depends on the installed Pizza version and provider setup. The site does not claim that unreleased integrations are included in older installers.

## Assets and provenance

- `public/media/pizza-desktop.mp4`: converted from the repository's real `resources/demo-desktop.gif` using FFmpeg; no simulated product interface.
- `public/media/pizza-desktop.webp`: frame at five seconds from that same recording, compressed to WebP.
- App icon: the existing `apps/web/public/pizza-icon.png`, resized during build. The brand mark is unchanged.
- App and channel marks: Simple Icons, presented as supported connections, not customer endorsements. Interface glyphs: Phosphor.
- `assets-source/pizza-studio.png`: generated with the built-in image generation tool, then compressed by `scripts/prepare-assets.mjs` to `public/media/pizza-studio.webp`. The illustration supplements the existing mark.

Illustration prompt:

> Use case: stylized-concept. Asset type: wide website illustration for Pizza, an open-source desktop AI assistant. Create a refined, playful studio still-life: one large sculptural pizza slice made of smooth matte orange and golden yellow ceramic, with two round deep tomato-red pepperoni insets, floating at a gentle diagonal above a small stack of smooth pale ivory rounded tiles. A single soft ribbon of terracotta orange curls loosely behind the slice, suggesting continuity. Sophisticated tangible 3D art direction, generous negative space, warm near-white seamless studio backdrop, subtle contact shadows, soft daylight from upper left. Landscape 3:2 composition. Palette tightly limited to the pizza brand's orange, yellow, tomato red and pale ivory. No words, no lettering, no computer screens, no fake interface, no logo text, no extra symbols, no people, no watermark. This is a supporting brand illustration, not a replacement for the existing Pizza app logo.

## Verification (2026-11-15)

- Desktop and 390px mobile views checked in both English and Chinese, with light and dark themes. No mobile horizontal overflow or broken images was found.
- Verified the mobile menu, FAQ expansion, clipboard feedback, real video playback, dialog positioning, Escape-to-close, and focus return.
- Body/CTA contrast ratios: light body 5.59, light CTA 5.20, dark body 7.97, dark CTA 7.46.
- Website build and 48 OAuth/static-route regression tests passed. The Google OAuth chain also passed the existing real workerd/SQLite runtime fixture test.
- Deployed Worker version `70104aa5-7a01-4eed-bcc3-1edd35c80a0c`. Both language pages, scripts, styles, images and video return 200. All three installer URLs return 200. Unknown pages return 404, website POST returns 405, and OAuth metadata/readiness still return the expected JSON.
- Google PageSpeed's Lighthouse API was attempted but returned quota-exceeded (429); no Lighthouse score is claimed. Production dependencies audit: zero reported vulnerabilities.
