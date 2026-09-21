import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
