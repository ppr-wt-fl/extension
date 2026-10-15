import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadLists } from ".";

// vitest's asset urls are root-relative (file:///filterlists/...): read them from the project root
vi.stubGlobal("fetch", async (url: URL) =>
  new Response(readFileSync(new URL(`../../..${url.pathname}`, import.meta.url)), {
    headers: { "content-type": url.pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" },
  }),
);

test("names the lists that block", async () => {
  const check = await loadLists();
  const topLevelUrl = "https://www.example.com/";
  expect(check({ url: "https://securepubads.g.doubleclick.net/tag/js/gpt.js", topLevelUrl, type: "script" })).toEqual(["easylist"]);
  expect(check({ url: "https://www.google-analytics.com/analytics.js", topLevelUrl, type: "script" })).toEqual(["easyprivacy"]);
  expect(check({ url: "https://www.example.com/static/app.js", topLevelUrl, type: "script" })).toEqual([]);
  expect(check({ url: "not a url", topLevelUrl, type: "script" })).toEqual([]);
});
