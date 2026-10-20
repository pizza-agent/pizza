import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Web sources dynamically import @tauri-apps/*, which only exist under
// apps/web/node_modules — root `npm test` (CI `npm ci` installs no web deps)
// needs resolvable stubs so tests that stub Tauri internals can load them.
const stubDir = fileURLToPath(new URL('./test/stubs', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup-isolation.ts'],
    environment: 'node',
    testTimeout: 60000, // 60 seconds — CI runners are slower than local
    server: {
      deps: {
        external: [/@silvia-odwyer\/photon-node/],
      },
    },
  },
  resolve: {
    // Preserve symlinks to avoid issues with monorepo package resolution
    preserveSymlinks: true,
    alias: [
      { find: /^@tauri-apps\/api$/, replacement: `${stubDir}/tauri-api/index.js` },
      { find: /^@tauri-apps\/api\/(.+)$/, replacement: `${stubDir}/tauri-api/$1.js` },
      { find: /^@tauri-apps\/plugin-shell$/, replacement: `${stubDir}/plugin-shell/index.js` },
    ],
  },
});