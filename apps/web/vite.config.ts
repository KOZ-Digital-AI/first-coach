import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

// The build version (fc-mol-eay.9): the persisted query cache is dropped when it changes (lib/query-persist.ts reads
// import.meta.env.VITE_BUILD_VERSION). First the build's own VITE_BUILD_VERSION / BUILD_VERSION (the Dockerfile ARG), else the
// git short sha of the checkout, else "dev" (which never busts). Evaluated once, when the config is loaded.
function buildVersion(): string {
  for (const name of ['VITE_BUILD_VERSION', 'BUILD_VERSION']) {
    const value = process.env[name];
    if (value) return value;
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sha) return sha;
  } catch {
    // not a git checkout (e.g. a docker build context without .git)
  }
  return 'dev';
}

// PWA (fc-mol-eay.1). Exported so tests read it as data.
//
// - registerType 'prompt': a new service worker waits until the user accepts it.
// - manifest has no `lang`: the app is kk/ru/en and the name is bilingual.
// - precache = the app shell only: html, js (locale bundles are *.messages.ts, so they are in the
//   js chunks), css, the self-hosted Inter woff2 (NOT in workbox's default globPatterns, so it is
//   listed here or Inter would not work offline), the manifest icons and the favicon.
// - NO runtime caching: /api responses, video and *.task model files are never cached by the SW.
//   Media and models are also kept out of the precache (globIgnores), whatever else lands in dist.
// - navigations fall back to index.html, except /api, /health and media/uploads paths.
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  includeAssets: ['favicon.svg', 'favicon.ico'],
  manifest: {
    name: 'FIRST COACH — БІРІНШІ БАПКЕР',
    short_name: 'First Coach',
    theme_color: '#101815',
    background_color: '#f4f3ee',
    display: 'standalone',
    start_url: '/train',
    // vite-plugin-pwa defaults lang to 'en'; undefined overrides it and JSON.stringify drops the key.
    lang: undefined,
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
    globIgnores: ['**/*.{mp4,webm,task}'],
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [
      /^\/api(\/|$)/,
      /^\/health(\/|$)/,
      /^\/media(\/|$)/,
      /^\/uploads(\/|$)/,
      /\.(?:mp4|webm|task)$/,
    ],
    cleanupOutdatedCaches: true,
  },
};

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    VitePWA(pwaOptions),
  ],
  define: { 'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(buildVersion()) },
  resolve: {
    alias: {
      '@api-types': fileURLToPath(new URL('../api/src/shared', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4111' },
      '/health': { target: 'http://localhost:4111' },
    },
  },
});
