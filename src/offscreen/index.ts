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

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
    // content scripts' messages reach this document too
    if (message?.target !== "offscreen") return;
    const id = next++;
    replies.set(id, sendResponse);
    worker.postMessage({ id, message });
    return true;
  },
);
