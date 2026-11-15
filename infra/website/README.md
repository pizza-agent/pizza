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
- `src/demo.json` contains the public video/poster URLs. The desktop video and poster now come from the current native Pizza Dev recording described below; the `legacy-2026-11-15` desktop objects are retained only as an archive and have no website references. The old terminal GIF is archived at https://pizza.hertzbeat.com/media/demos/pizza-terminal-legacy-2026-11-15.gif.
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
- Deployed Worker version `386afa59-bc10-4361-ba4b-85175bc66810`. Both language pages, scripts, styles, images and video return 200. All three installer URLs return 200. Unknown pages return 404, website POST returns 405, and OAuth metadata/readiness still return the expected JSON.
- Google PageSpeed's Lighthouse API was attempted but returned quota-exceeded (429); no Lighthouse score is claimed. Production dependencies audit: zero reported vulnerabilities.

## Publishing a native desktop recording

1. Start the latest Pizza DEV desktop (`npm run dev:desktop`), keep the Mac unlocked, and use a curated demo workspace containing public sample data. Hide personal projects, chats, account details and credentials before recording.
2. Obtain the native Pizza screen-capture window ID from macOS CoreGraphics metadata. Record actual desktop interactions, not a browser simulation. The capture helper accepts an output path **outside** this checkout:

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

Media migration validation (2026-11-15): the real workerd/R2 fixture passed full responses, HEAD, bounded/open/suffix byte ranges, 416 handling, ETags and read-only routing; the existing SQLite OAuth fixture also passed. All 20 focused Worker route tests passed. Production English/Chinese pages reference the external video, video/poster/terminal GIF return 200, video seeking returns 206, missing media returns 404 and media writes return 405. The current native desktop recording is now complete; its MP4 and poster are published independently of the Git checkout.

## Current desktop demo (2026-11-15)

The current recording tells one 35-second story: **give the personal assistant a goal → workspaces execute → review the deliveries with the assistant**. It replaces the previous 90-second UI tour. Settings, MCP schemas and event-log inspection are excluded from this cut.

- Source: Pizza **0.5.5 development build**, commit `0d7d4ab35236b7b1662edf538f242323f4ac25ef`, native macOS app `ai.pizza.gui.dev`. All task input, delegation, workspace navigation, file modifications and replies are real desktop operations. No simulated interface or injected assistant response is used.
- Video: https://pizza.hertzbeat.com/media/demos/pizza-assistant-workspaces-35s-2026-11-15-0d7d4ab.mp4
- Poster: https://pizza.hertzbeat.com/media/demos/pizza-assistant-workspaces-35s-2026-11-15-0d7d4ab.webp (frame at 28 seconds of the published video).
- Format: **35 seconds**, 1440 × 960, 24 fps, H.264/yuv420p, silent fast-start MP4. Video size: **875,949 bytes**. Poster size: 77,312 bytes.
- Video SHA-256: `eb9bdaa16b8a80fcb884e2032375b28f730744ba020abf2150baebc8ae99a4d3`.
- Poster SHA-256: `b473cc96eaaa41279b0f018c2ca262ec13267185fcd4fd571f19ebc6abfdd40a`.
- Public demo task: ask the personal assistant to prepare a Pizza launch, delegate homepage copy to the `官网改版` workspace, and improve onboarding in `产品文档`. The real agents update `首页文案.md` and `快速开始.md`; the gateway relays their replies back, and the personal assistant actually produces the final combined summary. Both agents ran from the same initial request without manually prompting each workspace.
- Both fixture documents contain fictional public demonstration material. The video shows the website file preview and the documentation workspace's actual completion reply.
- Editing: remove OS capture padding (crop 2400 × 1600 at x=112, y=76), scale to 1440 × 960, and overlay chapter labels in the toolbar area. Use the source intervals below, in order. The 4× segments are clearly labeled **4× 快进**; all goal/result scenes retain their original speed. Pauses and irrelevant panel inspection are cut. Raw recordings and exports remain outside the Git checkout.

| Published interval | Source interval | Speed | Focus |
| --- | --- | --- | --- |
| 0–7s | 4–11s | 1× | Give the goal to the personal assistant |
| 7–10s | 11–23s | 4× | Assistant delegates the tasks |
| 10–13s | 23–35s | 4× | Workspace executes actual file edits |
| 13–21s | 41–49s | 1× | Inspect the website workspace's real output |
| 21–25s | 53–57s | 1× | Switch to the documentation workspace's result |
| 25–35s | 146–156s | 1× | Return to the assistant's combined delivery summary |

The previous long recording remains an immutable R2 archive, without active website or README links. No demo video binaries are included in the repository.

Current-cut verification: all 840 video frames decode without errors; the MP4 is exactly 35.00 seconds and fast-start metadata precedes video data. Remote video/poster hashes match the exports, and seeking returns 206. In the live browser, the new URL played with duration 35, readyState 4 and no media error; progress-bar navigation reached the workspace scene and the assistant summary. English and Chinese pages point to the new media.

## README features on the website

The page keeps the existing brand, routes, real 35-second desktop video, light/dark tokens and download flow. The design explorer is placed immediately after the hero and first in the navigation. Its desktop panel places the explanation beside the diagram, with a single-column mobile layout and deliberate headline wrapping. It leads into the real product demo and everyday capabilities, with model choice and extensibility under the open-source section. The layout retains variance 7 / motion 4 / density 3. It uses native CSS and the existing React/Phosphor stack, without new dependencies or simulated product screenshots.

| README topic | Website expression |
| --- | --- |
| Persistent assistant and cross-workspace collaboration | `WorkspaceStory`: assistant → project workspaces → combined results, followed by continuing-conversation notes |
| Automatic context compaction and token efficiency | Continuing-conversation notes and the single CLI execution-tool panel |
| SSH hosts as workspaces | Remote-workspace capability block |
| Slack, Discord, Telegram, Lark, voice and webhooks | Channel capability block, with setup requirements stated |
| Recurring tasks | Scheduling capability block |
| Reactor and immutable SQLite event log | Event-driven design panel: append sample events and see the three projections |
| Git-like branch memory | Memory panel: select either continuation while keeping the original path visible |
| A single CLI execution tool | Command diagram for `_read`, `_write`, `_edit` and `_tell` |
| GUI, TUI, JSON-RPC and print sharing a runtime | Shared-runtime diagram around `SessionFacade` |
| 40+ model providers, keys and subscription login | Model choice under the open-source section |
| MCP, skills, hooks, extensions, themes and SDK interfaces | Extensibility notes and the existing app-connections section |

The architecture graphics are explicitly labeled as illustrations. Event-step and branch controls operate only on these explanatory diagrams. The four design panels are server-rendered in both languages and use accessible tabs with Arrow Left/Right, Home and End navigation. Existing navigation labels and anchor IDs are preserved; capabilities and design get additional anchors. No analytics or OAuth behavior changes are introduced.


Feature/design verification (2026-11-15):

- Website build and English/Chinese pre-render checks passed. The design section precedes the product demo in both pages, its navigation link is first, and all four architecture panels appear in the generated HTML.
- Browser checks passed for event append/reset, branch selection, tab clicks, and Arrow Left/Right, Home/End navigation. Desktop and 390px mobile layouts were inspected in English/Chinese and light/dark themes. Temporary theme and viewport changes were restored.
- The 20 focused Worker route tests passed. The real workerd fixtures passed R2 media serving/seeking and encrypted SQLite OAuth/refresh behavior. Existing video, account metadata and health endpoints remain available.
- The external PageSpeed/Lighthouse API returned quota-exceeded (429); no new Lighthouse score is reported. The client bundle is approximately 76.15 kB gzip, with no added dependencies.
