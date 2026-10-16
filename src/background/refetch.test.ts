import { afterEach, beforeEach, expect, test, vi } from "vitest";

let calls: chrome.declarativeNetRequest.UpdateRuleOptions[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ours",
      getURL: (p: string) => `chrome-extension://ours/${p}`,
    },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
      getSessionRules: async () => [{ id: 7 }],
      updateSessionRules: async (
        o: chrome.declarativeNetRequest.UpdateRuleOptions,
      ) => {
        calls.push(o);
        if (o.addRules) throw new Error("rule refused");
      },
    },
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

test("refetch clears stale rules, fetches despite a refused rule, and removes it after a failed fetch", async () => {
  const { refetch } = await import("./refetch");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("body"))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetch);

  const url = "https://ads.example/a.js";
  expect(await refetch(url, "https://news.example")).toBeInstanceOf(
    ArrayBuffer,
  );
  expect(await refetch(url, "https://news.example")).toBeUndefined();
  await Promise.resolve();

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(calls[0]).toEqual({ removeRuleIds: [7] });
  const added = calls.flatMap((c) => c.addRules ?? []).map((r) => r.id);
  const removed = calls.slice(1).flatMap((c) => c.removeRuleIds ?? []);
  expect(added).toEqual([1, 2]);
  expect(removed).toEqual([1, 2]);
});

test("refetch skips non-text and oversized responses, and passes a timeout signal", async () => {
  const { refetch } = await import("./refetch");
  const { flags } = await import("@/lib/flags");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("x", { headers: { "content-type": "video/mp4" } }),
    )
    .mockResolvedValueOnce(
      new Response("x", {
        headers: { "content-type": "text/html", "content-length": "999999999" },
      }),
    )
    .mockResolvedValueOnce(
      new Response("x".repeat(flags.refetch.maxBytes + 1), {
        headers: { "content-type": "text/html" },
      }),
    )
    .mockResolvedValueOnce(
      new Response("ok", {
        headers: { "content-type": "binary/octet-stream" },
      }),
    );
  vi.stubGlobal("fetch", fetch);

  const url = "https://ads.example/a.js";
  expect(await refetch(url, undefined)).toBeUndefined();
  expect(await refetch(url, undefined)).toBeUndefined();
  expect(await refetch(url, undefined)).toBeUndefined();
  expect(await refetch(url, undefined)).toBeInstanceOf(ArrayBuffer);
  expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
