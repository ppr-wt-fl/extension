// ONlY FOR BENCHMARKING
//
// Page load with/without extension + extension metrics (src/perf).
//   bun run build && bun bench/pageload.ts [--runs 10] [--warmup 2] [--cpu 4] [--modes none,extension] URL...
// Fresh browser per mode (CHROME, default chromium: branded Chrome can't load unpacked). Warm-up = warm cache + JIT.
// Serve pages locally. --cpu throttles pages only, not extension.

import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
} from "puppeteer-core";

const { values: args, positionals: urls } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    cpu: { type: "string", default: "1" },
    modes: { type: "string", default: "none,extension" },
    out: { type: "string", default: "bench/results.json" },
    dist: { type: "string", default: "dist" },
  },
});
if (urls.length === 0)
  throw new Error("usage: bun bench/pageload.ts [options] URL...");

const runs = Number(args.runs);
const warmup = Number(args.warmup);
const cpu = Number(args.cpu);
const modes = args.modes.split(",") as ("none" | "extension")[];
/** Wait after load: late LCP, long tasks, content script summaries (2 s), SW flush. */
const SETTLE_MS = 2500;

type PageMetrics = Record<string, number>;

/** LCP + long tasks from document start. */
function observe() {
  const w = window as unknown as {
    __bench: { lcp: number; longTasks: number; longTaskMs: number };
  };
  w.__bench = { lcp: NaN, longTasks: 0, longTaskMs: 0 };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) w.__bench.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      w.__bench.longTasks++;
      w.__bench.longTaskMs += entry.duration;
    }
  }).observe({ type: "longtask", buffered: true });
}

async function load(browser: Browser, url: string): Promise<PageMetrics> {
  const page: Page = await browser.newPage();
  try {
    if (cpu > 1) await page.emulateCPUThrottling(cpu);
    await page.evaluateOnNewDocument(observe);
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return await page.evaluate(() => {
      const nav = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      const bench = (window as unknown as { __bench: Record<string, number> })
        .__bench;
      const resources = performance.getEntriesByType(
        "resource",
      ) as PerformanceResourceTiming[];
      return {
        ttfb: nav.responseStart,
        domContentLoaded: nav.domContentLoadedEventEnd,
        load: nav.loadEventEnd,
        lcp: bench.lcp,
        longTasks: bench.longTasks,
        longTaskMs: bench.longTaskMs,
        resources: resources.length,
        transferBytes: resources.reduce(
          (sum, r) => sum + r.transferSize,
          nav.transferSize,
        ),
      };
    });
  } finally {
    await page.close();
  }
}

/** JS heap per extension context. */
async function heaps(
  browser: Browser,
  id: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const target of browser.targets()) {
    if (!target.url().startsWith(`chrome-extension://${id}/`)) continue;
    let session: CDPSession | undefined;
    try {
      session = await target.createCDPSession();
      const { usedSize } = await session.send("Runtime.getHeapUsage");
      out[`${target.type()} ${new URL(target.url()).pathname}`] = usedSize;
    } catch {
      // not attachable
    } finally {
      await session?.detach().catch(() => {});
    }
  }
  return out;
}

function stats(values: number[]) {
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(
    finite.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1),
  );
  const sorted = [...finite].sort((a, b) => a - b);
  return { n, mean, sd, cv: sd / mean, median: sorted[Math.floor(n / 2)] };
}

const results: Record<string, unknown> = {
  args,
  urls,
  startedAt: new Date().toISOString(),
};

for (const mode of modes) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/chromium",
    headless: true,
    pipe: true,
    enableExtensions: mode === "extension" ? [resolve(args.dist)] : false,
  });
  try {
    let id: string | undefined;
    if (mode === "extension") {
      const sw = await browser.waitForTarget(
        (t) =>
          t.type() === "service_worker" &&
          t.url().startsWith("chrome-extension://"),
      );
      id = new URL(sw.url()).host;
    }

    const pages: Record<string, Record<string, ReturnType<typeof stats>>> = {};
    const raw: Record<string, PageMetrics[]> = {};
    for (const url of urls) {
      for (let i = 0; i < warmup; i++) await load(browser, url);
      raw[url] = [];
      for (let i = 0; i < runs; i++) raw[url].push(await load(browser, url));
      const names = Object.keys(raw[url][0]);
      pages[url] = Object.fromEntries(
        names.map((k) => [k, stats(raw[url].map((m) => m[k]))]),
      );
      console.log(
        mode,
        url,
        Object.fromEntries(
          names.map((k) => [k, Math.round(pages[url][k].mean)]),
        ),
      );
    }

    let extension: unknown;
    if (id) {
      const sw = await browser.waitForTarget(
        (t) =>
          t.type() === "service_worker" &&
          t.url().startsWith(`chrome-extension://${id}/`),
      );
      const worker = await sw.worker();
      const snapshot = await worker?.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
          }
        ).chrome.runtime.sendMessage({ target: "offscreen", snapshot: true }),
      );
      extension = { snapshot, heaps: await heaps(browser, id) };
    }
    results[mode] = { pages, raw, extension };
  } finally {
    await browser.close();
  }
}

writeFileSync(args.out, JSON.stringify(results, null, 2));
console.log(`wrote ${args.out}`);
