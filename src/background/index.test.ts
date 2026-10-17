import { afterEach, beforeEach, expect, test, vi } from "vitest";

const observe = vi.fn(async () => true);
vi.mock("@/lib/collect", () => ({
  BODY_TYPES: new Set(["script", "sub_frame", "main_frame"]),
  observe,
  restoreAgain: async () => {},
  topLevelUrl: async () => "https://news.example/",
}));
vi.mock("@/lib/perf", () => ({
  count: () => {},
  gauge: () => {},
  now: () => 0,
  initSink: () => {},
  since: () => {},
}));
vi.mock("@/lib/perf/outbox", () => ({ writeMeta: async () => {} }));
vi.mock("@/lib/features", () => ({ featuresWasmBytes: () => undefined }));
vi.mock("./refetch", () => ({
  refetch: async () => new TextEncoder().encode("body").buffer,
}));

type Listener = (
  d: Partial<chrome.webRequest.OnCompletedDetails>,
) => Promise<void>;
let onCompleted: Listener;
beforeEach(() => {
  const listener = { addListener: () => {} };
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) => `chrome-extension://ours/${p}`,
      onStartup: listener,
      onInstalled: listener,
      onMessage: listener,
    },
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (items: Record<string, unknown>) =>
          void Object.assign(store, items),
      },
    },
    declarativeNetRequest: { getDynamicRules: async () => [] },
    webRequest: {
      onCompleted: { addListener: (l: Listener) => (onCompleted = l) },
    },
  });
  observe.mockClear();
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const details = (url: string, type: string) => ({
  url,
  type: type as chrome.webRequest.ResourceType,
  tabId: 1,
  frameId: 0,
  method: "GET",
  timeStamp: 0,
  initiator: "https://news.example",
});

test("a block verdict that can't get a rule is classified once, a blockable one again", async () => {
  await import("./index");

  const page = details("https://news.example/", "main_frame");
  await onCompleted(page);
  await onCompleted(page);
  expect(observe).toHaveBeenCalledTimes(1);

  // its rule would stop it completing again; if it does, it's classified again
  const ad = details("https://ads.example/a.js", "script");
  await onCompleted(ad);
  await onCompleted(ad);
  expect(observe).toHaveBeenCalledTimes(3);
});
