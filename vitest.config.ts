import path from "node:path";
import { defineConfig } from "vitest/config";
import { flags } from "./src/lib/flags.ts";

// Separate from vite.config.ts so the extension plugins (crx, zip) don't run in tests.
// The tests use the wasm in features/pkg, `bun run test` rebuilds it first.
export default defineConfig({
  // like vite.config.ts
  define: { "import.meta.env.ACORN": JSON.stringify(flags.acorn) },
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
