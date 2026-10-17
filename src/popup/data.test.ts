import { afterEach, expect, test, vi } from "vitest";
import { loadBlocked, loadRules } from "./data";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const allow = 2 ** 31 - 1;
const tab = { id: 3, url: "https://news.example/" } as chrome.tabs.Tab;

function stubChrome(getMatchedRules: () => Promise<unknown>) {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: Record<string, unknown>) =>
          Object.assign(store, items),
      },
    },
    declarativeNetRequest: {
      getMatchedRules,
      getDynamicRules: async () => [{ id: 1 }, { id: allow }],
    },
  });
}

const matches = (n: number) => async () => ({
  rulesMatchedInfo: [
    ...Array.from({ length: n }, () => ({ rule: { ruleId: 1 } })),
    { rule: { ruleId: allow } },
  ],
});

test("the allow rules of paused sites are neither blocked requests nor block rules", async () => {
  stubChrome(matches(1));
  expect(await loadBlocked(tab)).toBe(1);
  expect((await loadRules()).installed).toBe(1);
});

test("loadBlocked reuses a recent count of the same page, unless fresh", async () => {
  const getMatchedRules = vi.fn(matches(1));
  stubChrome(getMatchedRules);
  expect(await loadBlocked(tab)).toBe(1);
  getMatchedRules.mockImplementation(matches(2));
  expect(await loadBlocked(tab)).toBe(1);
  // another page in the same tab
  expect(await loadBlocked({ ...tab, url: "https://other.example/" })).toBe(2);
  expect(await loadBlocked(tab, true)).toBe(2);
  expect(getMatchedRules).toHaveBeenCalledTimes(3);
});

test("loadBlocked falls back to an old count when Chrome refuses", async () => {
  vi.useFakeTimers();
  const getMatchedRules = vi.fn(matches(1));
  stubChrome(getMatchedRules);
  expect(await loadBlocked(tab)).toBe(1);
  vi.advanceTimersByTime(60_000);
  getMatchedRules.mockRejectedValue(new Error("quota"));
  expect(await loadBlocked(tab)).toBe(1);
  expect(await loadBlocked({ ...tab, url: "https://other.example/" })).toBe(
    undefined,
  );
});
