import path from 'node:path'
import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import zip from 'vite-plugin-zip-pack'
import manifest from './manifest.config.ts'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  plugins: [
    react(),
    crx({ manifest }),
    zip({ outDir: 'release', outFileName: `crx-${pkg.name}-${pkg.version}.zip` }),
  ],
  build: {
    rollupOptions: {
      // not in the manifest: the service worker opens them (chrome.offscreen, chrome.tabs on install)
      input: {
        offscreen: 'src/offscreen/index.html',
        onboarding: 'src/onboarding/index.html',
      },
    },
  },
  server: {
    // the client runs on chrome-extension:// (no port), so vite must be told the ws port explicitly
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
    cors: {
      origin: [
        /chrome-extension:\/\//,
      ],
    },
  },
})
