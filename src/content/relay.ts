// forwards patch.ts's captures and the frame's DOM to the background.

/** What the content scripts send the background. */
export type RelayMessage =
  | { source: "captured_by_patch"; url: string; method: string; body?: string }
  | { source: "dom"; body: string };

/** Same as in patch.ts, which can't import it. */
const TAG = "__blocker_patch__";

function send(message: RelayMessage) {
  // throws once the extension is reloaded, until the page is
  chrome.runtime.sendMessage(message).catch(() => {});
}

window.addEventListener("message", (event) => {
  // the page can post this too, so patch messages are untrusted
  const data = event.source === window && event.data?.[TAG];
  if (data) send({ source: "captured_by_patch", ...data });
});

window.addEventListener("load", () => {
  if (document.contentType.includes("html")) {
    send({ source: "dom", body: document.documentElement.outerHTML });
  }
});
