import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flags } from "@/lib/flags";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (items: Record<string, unknown>) =>
          void Object.assign(store, items),
      },
    },
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const entry = (t: number) => ({
  classifiedAt: t,
  checkedAt: t,
  validator: 5,
  body: 7,
});

test("tier: fresh, then validate for bodies, then full past maxAgeMs", async () => {
  const c = await import("./checked");
  const t = c.nowS();
  const key = c.hashRuleKey("k");
  expect(c.tier(key, true, t)).toBe("run-from-scratch");
  c.put(key, entry(t));
  expect(c.tier(key, true, t + 1)).toBe("fresh");
  const pastFresh = t + flags.cache.freshMs / 1000 + 1;
  expect(c.tier(key, true, pastFresh)).toBe("needs-body-validation");
  // URL-only: its features can't have changed
  expect(c.tier(key, false, pastFresh)).toBe("fresh");
  expect(c.tier(key, false, t + flags.cache.maxAgeMs / 1000 + 1)).toBe("run-from-scratch");
  c.pending.add(key);
  expect(c.tier(key, true, t)).toBe("inflight");
});

test("put evicts the least recently used past maxEntries, touch counts as a use", async () => {
  const c = await import("./checked");
  // the module's own flags, a new instance since resetModules
  const { flags } = await import("@/lib/flags");
  const max = flags.cache.maxEntries;
  flags.cache.maxEntries = 2;
  try {
    c.put(1, entry(c.nowS()));
    c.put(2, entry(c.nowS()));
    c.touch(1);
    c.put(3, entry(c.nowS()));
    expect([c.get(1), c.get(2), c.get(3)].map(Boolean)).toEqual([
      true,
      false,
      true,
    ]);
  } finally {
    flags.cache.maxEntries = max;
  }
});

test("save then load keeps 53-bit keys, fields and order, drops expired", async () => {
  let c = await import("./checked");
  const t = c.nowS();
  const key = c.hashRuleKey("big");
  expect(key).toBeGreaterThan(2 ** 32);
  c.put(key, entry(t));
  c.put(9, entry(t - flags.cache.maxAgeMs / 1000 - 1));
  await c.save();

  vi.resetModules();
  c = await import("./checked");
  await c.ready();
  expect(c.get(key)).toEqual(entry(t));
  expect(c.get(9)).toBeUndefined();
});

test("validator: strong ETag, else Last-Modified with length", async () => {
  const { validator } = await import("./checked");
  const h = (o: Record<string, string>) =>
    Object.entries(o).map(([name, value]) => ({ name, value }));
  expect(validator(h({ ETag: '"a"' }))).toBe('"a"');
  expect(
    validator(h({ ETag: 'W/"a"', "Content-Length": "3" })),
  ).toBeUndefined();
  expect(validator(h({ "Last-Modified": "x", "Content-Length": "3" }))).toBe(
    "x|3",
  );
});
