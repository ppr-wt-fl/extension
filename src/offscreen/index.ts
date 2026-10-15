import { now } from "@/lib/perf";
import type { LearnerReply, OffscreenRequest } from "./worker";

// Relays the service worker's requests to the learner, which runs in a worker so training doesn't block the main
// thread this document shares with the popup.

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
const replies = new Map<number, (reply: LearnerReply) => void>();
let next = 0;

worker.onmessage = ({
  data,
}: MessageEvent<{ id: number; reply: LearnerReply }>) => {
  replies.get(data.id)?.(data.reply);
  replies.delete(data.id);
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
