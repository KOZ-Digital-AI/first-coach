import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

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
