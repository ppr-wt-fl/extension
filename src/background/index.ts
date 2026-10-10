import { BODY_TYPES, observe, topLevelUrl, type Observation } from "../collect";
import type { RelayMessage } from "../content/relay";
import { flags } from "../flags";
import { captureWithDebugger } from "./debugger";

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    // Requests outside tabs have no top-level page.
    // These include the refetches below, and page service workers' requests.
    if (details.tabId < 0) return;

    // FIXME: MAYBE THIS CAN BE DONE IN A BETTER WAY
    const top =
      details.type === "main_frame"
        ? details.url
        : await topLevelUrl(details.tabId);
    if (!top) return;

    const observation: Observation = {
      source: "webRequest",
      req: { url: details.url, topLevelUrl: top, type: details.type },
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      timeStamp: details.timeStamp,
    };

    if (!BODY_TYPES.has(details.type)) return observe(observation);
    // Only GET is safe to repeat
    const body =
      details.method === "GET" ? await refetch(details.url) : undefined;
    return observe({
      ...observation,
      source: "refetch",
      req: { ...observation.req, body },
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.runtime.onMessage.addListener((message: RelayMessage, sender) => {
  const tabId = sender.tab?.id;
  const top = sender.tab?.url;
  if (tabId === undefined || !top || !sender.url) return;

  const isPatch = message.source === "captured_by_patch";
  observe({
    source: message.source,
    req: {
      // webRequest URLs have no fragment
      url: isPatch ? message.url : sender.url.split("#")[0],
      topLevelUrl: top,
      // Chrome's webRequest type for both fetch and XHR
      type: isPatch
        ? "xmlhttprequest"
        : sender.frameId === 0
          ? "main_frame"
          : "sub_frame",
      body: message.body,
    },
    tabId,
    frameId: sender.frameId,
    method: isPatch ? message.method : undefined,
    timeStamp: Date.now(),
  }).catch(console.error);
});

if (flags.debugger) captureWithDebugger();

/**
 * Downloads a URL again, for the body webRequest doesn't expose. It can differ from what the page got: this request
 * has another cache partition, Referer and, depending on SameSite, cookies.
 */
async function refetch(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { credentials: "include" });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}
