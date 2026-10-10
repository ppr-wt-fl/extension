// Runs in the page's JS world at document_start to read the bodies of the page's own fetch and XHR requests,
// and posts them to relay.ts. Not seen: <script src>, frames, workers' requests, sendBeacon, WebSockets.
// No imports or exports besides types: CRXJS then injects the bundle as is. Otherwise it loads it with an async
// import(), and the page's scripts run first. In dev mode it is always loaded that way.
import type { RelayMessage } from "./relay";

const TAG = "__blocker_patch__";
const MAX_BODY_LENGTH = 5_000_000;

type Capture = {
  source: "captured_by_patch";
  url: string;
  method: string;
  body?: string;
};

function post(capture: Capture) {
  window.postMessage({ [TAG]: capture }, "*");
}

/** Text MIME types outside text/* */
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/xml",
]);

/** Whether a response with these headers has a text body we want */
function wanted(
  contentType: string | null,
  contentLength: string | null,
): boolean {
  if (Number(contentLength) > MAX_BODY_LENGTH) return false;
  // no header, could be text
  if (!contentType) return true;

  // "text/html; charset=utf-8" -> "text/html"
  const mime = contentType.split(";")[0].trim().toLowerCase();
  // event streams never end, so text() would never resolve
  if (mime === "text/event-stream") return false;
  return (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    // e.g. application/ld+json, image/svg+xml
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

// Overwrite fetch
const fetch = window.fetch;
window.fetch = async function (
  this: unknown,
  ...args: Parameters<typeof fetch>
) {
  const response = await fetch.apply(this, args);
  const [input, init] = args;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  // opaque (no-cors) responses have neither URL nor body
  if (response.url) {
    const copy = response.clone();
    const read = wanted(
      copy.headers.get("content-type"),
      copy.headers.get("content-length"),
    )
      ? copy.text()
      : Promise.resolve(undefined);
    read
      .then((body) =>
        post({
          source: "captured_by_patch",
          url: response.url,
          method,
          body: body && body.length <= MAX_BODY_LENGTH ? body : undefined,
        }),
      )
      .catch(() =>
        post({ source: "captured_by_patch", url: response.url, method }),
      );
  }
  return response;
};

const methods = new WeakMap<XMLHttpRequest, string>();

// Overwrite XMLHttpRequest
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  ...args: Parameters<typeof open>
) {
  methods.set(this, args[0].toUpperCase());
  return open.apply(this, args);
} as typeof open;

const send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (
  this: XMLHttpRequest,
  ...args: Parameters<typeof send>
) {
  this.addEventListener("loadend", () => {
    if (!this.responseURL) return;
    const text =
      (this.responseType === "" || this.responseType === "text") &&
      wanted(this.getResponseHeader("content-type"), null);
    const body =
      text && this.responseText.length <= MAX_BODY_LENGTH
        ? this.responseText
        : undefined;
    post({
      source: "captured_by_patch",
      url: this.responseURL,
      method: methods.get(this) ?? "GET",
      body,
    });
  });
  return send.apply(this, args);
};
