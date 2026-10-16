import { afterEach, expect, test, vi } from "vitest";
import { flags } from "@/lib/flags";
import { decode, encode, gauge, initSink, record, type Sample } from ".";

// initSink writes to the outbox (IndexedDB); collect the samples here instead
const got = vi.hoisted((): Sample[] => []);
vi.mock("./outbox", () => ({
  outboxSink: () => (s: Sample[]) => got.push(...s),
}));

afterEach(() => {
  vi.useRealTimers();
  got.length = 0;
});

test("encode interns names, decode restores the samples", () => {
  const samples: Sample[] = [
    ["a", 1, 1000],
    ["b", 2.5, 1000.25],
    ["a", NaN, 1003],
  ];
  const encoded = encode(samples, "sw", "abc");
  expect(encoded.names).toEqual(["a", "b"]);
  expect([...encoded.ids]).toEqual([0, 1, 0]);
  const rows = [...decode(encoded)];
  expect(rows.map((r) => [r.name, r.value, r.ctx, r.instance])).toEqual([
    ["a", 1, "sw", "abc"],
    ["b", 2.5, "sw", "abc"],
    ["a", NaN, "sw", "abc"],
  ]);
  rows.forEach((r, i) => expect(r.t).toBeCloseTo(samples[i][2], 3));
});

test("a sink gets the buffered samples after its delay", () => {
  vi.useFakeTimers();
  record("sw.starts", 1);
  initSink("test", 100);
  record("browser.starts", 2);
  expect(got).toEqual([]);
  vi.advanceTimersByTime(100);
  expect(got.map(([name, value]) => [name, value])).toEqual([
    ["sw.starts", 1],
    ["browser.starts", 2],
  ]);
});

test("without a sink, the buffer keeps the newest maxBuffer samples", async () => {
  vi.resetModules();
  const perf = await import(".");
  vi.useFakeTimers();
  const n = flags.perf.maxBuffer;
  for (let i = 0; i < n + 5; i++) perf.record("rules", i);
  perf.initSink("test");
  vi.runAllTimers();
  expect(got).toHaveLength(n);
  expect(got[0][1]).toBe(5);
});

test("gauge records only changes", () => {
  vi.useFakeTimers();
  initSink("test");
  gauge("rules", 1);
  gauge("rules", 1);
  gauge("rules", 2);
  vi.runAllTimers();
  expect(got.map(([, value]) => value)).toEqual([1, 2]);
});
