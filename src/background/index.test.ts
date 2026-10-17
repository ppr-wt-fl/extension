import { afterEach, beforeEach, expect, test, vi } from "vitest";

const updateDynamicRules = vi.fn(async () => {});
const clear = vi.fn(async () => {});
const restoreAgain = vi.fn(async () => {});
vi.mock("@/lib/collect", () => ({
  BODY_TYPES: [],
  observe: vi.fn(),
  restoreAgain,
  topLevelUrl: vi.fn(),
}));
vi.mock("./checked", () => ({ clear, pending: new Set() }));
vi.mock("./refetch", () => ({ refetch: vi.fn() }));
vi.mock("@/lib/perf", () => ({
  count: vi.fn(),
  gauge: vi.fn(),
  now: vi.fn(),
  initSink: vi.fn(),
  since: vi.fn(),
}));

let onInstalled: (d: { reason: string }) => void;
const noEvent = { addListener: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    runtime: {
      onStartup: noEvent,
      onMessage: noEvent,
      onInstalled: {
        addListener: (f: typeof onInstalled) => (onInstalled = f),
      },
      getURL: (p: string) => p,
    },
    tabs: { create: vi.fn() },
    webRequest: { onCompleted: noEvent },
    declarativeNetRequest: {
      getDynamicRules: async () => [{ id: 5 }, { id: 6 }],
      updateDynamicRules,
    },
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

test("an extension update removes the block rules and the verdict cache, an install does not", async () => {
  await import("./index");
  onInstalled({ reason: "install" });
  expect(updateDynamicRules).not.toHaveBeenCalled();

  onInstalled({ reason: "update" });
  await vi.waitFor(() => expect(restoreAgain).toHaveBeenCalled());
  expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [5, 6] });
  expect(clear).toHaveBeenCalledTimes(1);
});
