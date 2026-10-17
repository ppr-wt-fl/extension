import path from "node:path";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import zip from "vite-plugin-zip-pack";
import { flags } from "./src/lib/flags.ts";
import manifest from "./manifest.config.ts";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  // a constant (define can't replace the imported flags), so without it the bundle drops acorn-loose
  define: { "import.meta.env.ACORN": JSON.stringify(flags.acorn) },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  plugins: [
    react(),
    crx({ manifest }),
    zip({
      outDir: "release",
      outFileName: `${pkg.name}-${pkg.version}.zip`,
    }),
  ],
  build: {
    rollupOptions: {
      // acorn and acorn-loose don't declare sideEffects: false, so without flags.acorn the unused import would stay
      treeshake: {
        moduleSideEffects: (id) => !/\/node_modules\/acorn(-loose)?\//.test(id),
      },
      // not in the manifest: the service worker opens them (chrome.offscreen, chrome.tabs on install)
      input: {
        offscreen: "src/offscreen/index.html",
        onboarding: "src/onboarding/index.html",
      },
    },
  },
  server: {
    // the client runs on chrome-extension:// (no port), so vite must be told the ws port explicitly
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
    cors: {
      origin: [/chrome-extension:\/\//],
    },
  },
});
