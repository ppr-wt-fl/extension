import path from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the extension plugins (crx, zip) don't run in tests.
// The tests use the wasm in features/pkg, `bun run test` rebuilds it first.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "features/tests/**/*.test.ts"],
    setupFiles: ["features/tests/setup.ts"],
  },
});
