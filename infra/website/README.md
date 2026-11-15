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

- Product media is stored outside Git in the dedicated Cloudflare R2 bucket `pizza-public-media`. The existing Worker exposes only read-only `/media/demos/` objects, including byte ranges for seeking. Deploying the website does not copy, download or remove those objects.
- `src/demo.json` contains the public video/poster URLs. The `legacy-2026-11-15` files preserve the previous website recording while a new native desktop capture is pending; they do not demonstrate the current UI. The old terminal GIF is archived at https://pizza.hertzbeat.com/media/demos/pizza-terminal-legacy-2026-11-15.gif.
- MP4/MOV/WebM recordings and resource demo GIFs are ignored. No demo video binaries remain in the current Git tree; existing Git history is preserved.
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
- Deployed Worker version `7204f547-a690-41b6-aea0-c50cfc905075`. Both language pages, scripts, styles, images and video return 200. All three installer URLs return 200. Unknown pages return 404, website POST returns 405, and OAuth metadata/readiness still return the expected JSON.
- Google PageSpeed's Lighthouse API was attempted but returned quota-exceeded (429); no Lighthouse score is claimed. Production dependencies audit: zero reported vulnerabilities.

## Publishing a native desktop recording

1. Start the latest Pizza DEV desktop (`npm run dev:desktop`), keep the Mac unlocked, and use a curated demo workspace containing public sample data. Hide personal projects, chats, account details and credentials before recording.
2. Obtain the native Pizza window ID from the computer-use window inventory. Record actual desktop interactions, not a browser simulation. The capture helper accepts an output path **outside** this checkout:

   ```sh
   node scripts/record-desktop-demo.cjs WINDOW_ID 120 /tmp/pizza-desktop-YYYY-MM-DD.mov
   ffmpeg -i /tmp/pizza-desktop-YYYY-MM-DD.mov -an -vf 'scale=1440:-2:flags=lanczos' -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart /tmp/pizza-desktop-YYYY-MM-DD-COMMIT.mp4
   ffmpeg -ss POSTER_SECONDS -i /tmp/pizza-desktop-YYYY-MM-DD-COMMIT.mp4 -frames:v 1 /tmp/pizza-desktop-YYYY-MM-DD-COMMIT.webp
   ```

3. Inspect the recording and poster for readability and personal content. Note source commit, actual operations, duration, resolution and SHA-256 in this document. Do not label a legacy capture as a current native recording.
4. Upload the MP4 and poster through Wrangler, using new immutable filenames on each release:

   ```sh
   cd infra/mcp-oauth
   npx wrangler r2 object put pizza-public-media/demos/pizza-desktop-YYYY-MM-DD-COMMIT.mp4 --file /tmp/pizza-desktop-YYYY-MM-DD-COMMIT.mp4 --content-type video/mp4 --cache-control 'public, max-age=31536000, immutable' --remote
   npx wrangler r2 object put pizza-public-media/demos/pizza-desktop-YYYY-MM-DD-COMMIT.webp --file /tmp/pizza-desktop-YYYY-MM-DD-COMMIT.webp --content-type image/webp --cache-control 'public, max-age=31536000, immutable' --remote
   ```

5. Update `src/demo.json` and the README desktop links to `https://pizza.hertzbeat.com/media/demos/FILENAME`. Keep poster and video from the same recording. Verify 200/206 responses, playback and seeking before deploying and committing. Do not put recordings in the checkout or GitHub attachments.

The bucket is bound as `PUBLIC_MEDIA`; no public R2 bucket endpoint or client write API is enabled. Only designated demo media extensions are served. Existing OAuth routing and bindings remain separate.

Media migration validation (2026-11-15): the real workerd/R2 fixture passed full responses, HEAD, bounded/open/suffix byte ranges, 416 handling, ETags and read-only routing; the existing SQLite OAuth fixture also passed. All 20 focused Worker route tests passed. Production English/Chinese pages reference the external video, video/poster/terminal GIF return 200, video seeking returns 206, missing media returns 404 and media writes return 405. Native current-version recording remains pending because the host Mac is locked.
