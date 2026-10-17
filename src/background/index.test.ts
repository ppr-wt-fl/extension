import { afterEach, beforeEach, expect, test, vi } from "vitest";

const observe = vi.fn(async () => true);
const restoreAgain = vi.fn(async () => {});
vi.mock("@/lib/collect", () => ({
  BODY_TYPES: new Set(["script", "sub_frame", "main_frame"]),
  observe,
  restoreAgain,
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
let onInstalled: (d: { reason: string }) => void;
const updateDynamicRules = vi.fn(async () => {});
const removeSession = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  const listener = { addListener: () => {} };
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) => `chrome-extension://ours/${p}`,
      onStartup: listener,
      onInstalled: {
        addListener: (f: typeof onInstalled) => (onInstalled = f),
      },
      onMessage: listener,
    },
    tabs: { create: vi.fn() },
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (items: Record<string, unknown>) =>
          void Object.assign(store, items),
        remove: removeSession,
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [{ id: 5 }, { id: 6 }],
      updateDynamicRules,
    },
    webRequest: {
      onCompleted: { addListener: (l: Listener) => (onCompleted = l) },
    },
  });
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

test("an extension update removes the block rules and the verdict cache, an install does not", async () => {
  await import("./index");
  onInstalled({ reason: "install" });
  expect(updateDynamicRules).not.toHaveBeenCalled();

  onInstalled({ reason: "update" });
  await vi.waitFor(() => expect(restoreAgain).toHaveBeenCalled());
  expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [5, 6] });
  expect(removeSession).toHaveBeenCalledWith("checked");
});
