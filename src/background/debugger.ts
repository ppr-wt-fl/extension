import { observe, topLevelUrl } from "../collect";

// Captures every response body of every tab through the Chrome DevTools Protocol. Enabled by `flags.debugger`.
// TODO: attaching on navigation can miss the main document; out-of-process iframes are separate targets
// (needs Target.setAutoAttach with flatten).

/** Main frame id by attached tab, to tell main_frame from sub_frame documents. */
const attached = new Map<number, string | undefined>();
/** Tabs where the user cancelled the debugging banner. */
const cancelled = new Set<number>();
/** Requests by tab and CDP request id, until they finish loading. */
const pending = new Map<string, { url: string; method: string; type: string; frameId: string }>();

/** CDP resource types whose bodies are text. */
const TEXT_TYPES = new Set(["Document", "Script", "Stylesheet", "XHR", "Fetch", "Manifest", "Other"]);

/** chrome.webRequest's resource type for a CDP resource type. */
function webRequestType(type: string, frameId: string, mainFrameId: string | undefined): string {
  switch (type) {
    case "Document":
      return frameId === mainFrameId ? "main_frame" : "sub_frame";
    case "XHR":
    case "Fetch":
      return "xmlhttprequest";
    case "CSPViolationReport":
      return "csp_report";
    case "Script":
    case "Stylesheet":
    case "Image":
    case "Font":
    case "Media":
    case "WebSocket":
    case "Ping":
      return type.toLowerCase();
    default:
      return "other";
  }
}

async function attach(tabId: number) {
  if (attached.has(tabId) || cancelled.has(tabId)) return;
  attached.set(tabId, undefined);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    const { frameTree } = (await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree")) as {
      frameTree: { frame: { id: string } };
    };
    attached.set(tabId, frameTree.frame.id);
  } catch {
    // chrome:// pages, the web store, or already detached
    attached.delete(tabId);
  }
}

async function onEvent(source: chrome.debugger.Debuggee, method: string, params?: object) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  if (method === "Network.requestWillBeSent") {
    // sent again with the same id on redirects, so this ends up with the final URL
    const { requestId, request, type, frameId } = params as {
      requestId: string;
      request: { url: string; method: string };
      type?: string;
      frameId?: string;
    };
    pending.set(`${tabId}:${requestId}`, { url: request.url, method: request.method, type: type ?? "Other", frameId: frameId ?? "" });
  } else if (method === "Network.loadingFailed") {
    pending.delete(`${tabId}:${(params as { requestId: string }).requestId}`);
  } else if (method === "Network.loadingFinished") {
    const { requestId } = params as { requestId: string };
    const request = pending.get(`${tabId}:${requestId}`);
    pending.delete(`${tabId}:${requestId}`);
    if (!request || !/^https?:/.test(request.url)) return;
    const top = await topLevelUrl(tabId);
    if (!top) return;
    let body: string | undefined;
    if (TEXT_TYPES.has(request.type)) {
      try {
        const response = (await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId })) as {
          body: string;
          base64Encoded: boolean;
        };
        if (!response.base64Encoded) body = response.body;
      } catch {
        // evicted from the DevTools buffer
      }
    }
    await observe({
      source: "debugger",
      req: { url: request.url, topLevelUrl: top, type: webRequestType(request.type, request.frameId, attached.get(tabId)), body },
      tabId,
      method: request.method,
      timeStamp: Date.now(),
    });
  }
}

export function captureWithDebugger() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    onEvent(source, method, params).catch(console.error);
  });
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId === undefined) return;
    attached.delete(tabId);
    if (reason === "canceled_by_user") cancelled.add(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "loading") void attach(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => cancelled.delete(tabId));
  chrome.tabs.query({}).then((tabs) => tabs.forEach((tab) => tab.id !== undefined && attach(tab.id)));
}
