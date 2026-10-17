import { flags } from "@/lib/flags";
import { gauge, initSink, now } from "@/lib/perf";
import type { LearnerReply, OffscreenRequest } from "./worker";

// Relays the service worker's requests to the learner, which runs in a worker so training doesn't block the main
// thread this document shares with the popup.

initSink("offscreen");

// JS heap of this renderer's main isolate: this document, plus the popup while open (likely same process). Chrome-only,
// Window-only. Precise if the process is site-locked (likely for extensions, unverified), else bucketed (~6% steps)
// and cached for 20 min. No measureUserAgentSpecificMemory: it needs cross-origin isolation.
type MemoryInfo = { usedJSHeapSize: number; totalJSHeapSize: number };
const heap = () => (performance as { memory?: MemoryInfo }).memory;
if (flags.perf.enabled && heap()) {
  // shortcut: every minute, not flushMs: the heap changes every tick, so each sample is an outbox write even when
  // idle. Shorten for finer curves if the outbox stays small.
  setInterval(() => {
    // a new snapshot per read
    const { usedJSHeapSize, totalJSHeapSize } = heap()!;
    gauge("offscreen.heapUsed", usedJSHeapSize);
    gauge("offscreen.heapTotal", totalJSHeapSize);
  }, 60_000);
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
const replies = new Map<number, (reply: LearnerReply) => void>();
let next = 0;

worker.onmessage = ({
  data,
}: MessageEvent<
  | { id: number; reply: LearnerReply }
  | { failed: string }
  | { resetRules: true }
>) => {
  if ("resetRules" in data) {
    // the popup's reset message, handled by the service worker (src/background)
    chrome.runtime
      .sendMessage({ resetRules: true })
      .catch((error) => console.error("rule reset failed", error));
  } else if ("failed" in data) {
    settleWorkersPendingRepliesWithErrors(
      `worker failed to start: ${data.failed}`,
    );
  } else {
    replies.get(data.id)?.(data.reply);
    replies.delete(data.id);
  }
};

// A dead worker never answers, and the service worker's sendMessage would wait forever on this live document. Answer
// everything pending with an error and close, so the service worker recreates the document on its next request.
// shortcut: no timeout for a worker that is alive but stalled, add one in observe() if that happens.
let died: string | undefined;
function settleWorkersPendingRepliesWithErrors(reason: string) {
  died = reason;
  for (const reply of replies.values()) reply({ error: reason, closing: true });
  replies.clear();
  close();
}
worker.onerror = (event) =>
  settleWorkersPendingRepliesWithErrors(`worker crashed: ${event.message}`);
worker.onmessageerror = () =>
  settleWorkersPendingRepliesWithErrors("worker sent an unreadable message");

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
    // content scripts' messages reach this document too
    if (message?.target !== "offscreen") return;
    // close() isn't instant: the service worker may still find this document and send it requests
    if (died !== undefined) {
      sendResponse({ error: died, closing: true } satisfies LearnerReply);
      return;
    }
    const id = next++;
    replies.set(id, sendResponse);
    // for hop.*
    worker.postMessage({ id, message, relayedAt: now() });
    return true;
  },
);

// the service worker waits for this before its first request (src/lib/collect ensureOffscreenDocument)
void chrome.runtime.sendMessage({ offscreenReady: true });
