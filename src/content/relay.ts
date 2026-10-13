// forwards patch.ts's captures and the frame's DOM to the background.
import { flags } from "@/flags";

/** What the content scripts send the background. */
export type RelayMessage =
  | { source: "captured_by_patch"; url: string; method: string; body?: string }
  | {
      source: "dom";
      body: string;
      /** outerHTML time, with flags.perf */
      serializeMs?: number;
    }
  /** patch.ts main-thread time since last summary */
  | { source: "patch_perf"; ms: number; captures: number }
  /** relay.ts main-thread time since last summary */
  | { source: "relay_perf"; ms: number };

/** Same as in patch.ts, which can't import it. */
const TAG = "__blocker_patch__";
const PERF_MS = 2000;

function send(message: RelayMessage) {
  // throws once the extension is reloaded, until the page is
  chrome.runtime.sendMessage(message).catch(() => {});
}

let relayMs = 0;
let perfScheduled = false;

function spent(start: number) {
  if (!flags.perf.enabled) return;
  relayMs += performance.now() - start;
  if (perfScheduled) return;
  perfScheduled = true;
  setTimeout(flushPerf, PERF_MS);
}

function flushPerf() {
  perfScheduled = false;
  if (relayMs === 0) return;
  send({ source: "relay_perf", ms: relayMs });
  relayMs = 0;
}
if (flags.perf.enabled) addEventListener("pagehide", flushPerf);

window.addEventListener("message", (event) => {
  // the page can post this too, so patch messages are untrusted
  const data: RelayMessage | false =
    event.source === window && event.data?.[TAG];
  if (!data) return;
  if (data.source === "patch_perf") {
    if (flags.perf.enabled) send(data);
    return;
  }
  const start = performance.now();
  send({ ...data, source: "captured_by_patch" } as RelayMessage);
  spent(start);
});

window.addEventListener("load", () => {
  if (document.contentType.includes("html")) {
    const start = performance.now();
    const body = document.documentElement.outerHTML;
    const serializeMs = performance.now() - start;
    send({
      source: "dom",
      body,
      serializeMs: flags.perf.enabled ? serializeMs : undefined,
    });
    spent(start);
  }
});
