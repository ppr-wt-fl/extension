import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };
import { flags } from "./src/lib/flags.ts";

export default defineManifest({
  manifest_version: 3,
  name: pkg.name,
  description: pkg.description,
  version: pkg.version,
  // async iteration of a ReadableStream (refetch)
  minimum_chrome_version: "124",
  icons: {
    48: "public/logo.png",
  },
  action: {
    default_icon: {
      48: "public/logo.png",
    },
    default_popup: "src/popup/index.html",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: [
    "webRequest",
    "offscreen",
    "declarativeNetRequest",
    // storage.session: requests already checked (src/background/checked.ts)
    "storage",
    // popup: declarativeNetRequest.getMatchedRules for the active tab
    "activeTab",
    // perf: IndexedDB outbox, rule hits (unpacked only)
    ...(flags.perf.enabled
      ? ["unlimitedStorage" as const, "declarativeNetRequestFeedback" as const]
      : []),
  ],
  host_permissions: ["<all_urls>"],
  content_security_policy: {
    // instantiating the feature extraction wasm needs wasm-unsafe-eval
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
