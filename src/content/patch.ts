// Runs in the page's JS world at document_start to read the bodies of the page's own fetch and XHR requests,
// and posts them to relay.ts. Not seen: <script src>, frames, workers' requests, sendBeacon, WebSockets.
// No imports or exports besides types: CRXJS then injects the bundle as is. Otherwise it loads it with an async
// import(), and the page's scripts run first. In dev mode it is always loaded that way.
import type { RelayMessage } from "./relay";

const TAG = "__blocker_patch__";
const MAX_BODY_LENGTH = 5_000_000;

type Capture = Extract<RelayMessage, { source: "captured_by_patch" }>;
type PatchPerf = Extract<RelayMessage, { source: "patch_perf" }>;

function post(message: Capture | PatchPerf) {
  window.postMessage({ [TAG]: message }, "*");
}

// Main-thread time of patched fetch/XHR, summary every PERF_MS. Always on: can't read flags, relay.ts drops it.
const PERF_MS = 2000;
// ms: total time inside the fetch patches
// captures: number of fetch requests caught
let perf = { ms: 0, captures: 0 };
let perfScheduled = false;

function spent(start: number, captures = 0) {
  perf.ms += performance.now() - start;
  perf.captures += captures;
  if (perfScheduled) return;
  perfScheduled = true;
  setTimeout(flushPerf, PERF_MS);
}

function flushPerf() {
  perfScheduled = false;
  if (perf.ms === 0 && perf.captures === 0) return;
  post({ source: "patch_perf", ...perf });
  perf = { ms: 0, captures: 0 };
}
addEventListener("pagehide", flushPerf);

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
  const start = performance.now();
  const [input, init] = args;
  // native fetch/XHR coerce the method; throwing here would fail the page's request
  const method = String(
    init?.method ?? (input instanceof Request ? input.method : "GET"),
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
      .then((body) => {
        const asyncStart = performance.now();
        post({
          source: "captured_by_patch",
          url: response.url,
          method,
          body: body && body.length <= MAX_BODY_LENGTH ? body : undefined,
        });
        // measures async time in fetch
        spent(asyncStart, 1);
      })
      .catch(() =>
        post({ source: "captured_by_patch", url: response.url, method }),
      );
  }
  // measures sync time in fetch
  spent(start);
  return response;
};

const methods = new WeakMap<XMLHttpRequest, string>();

// Overwrite XMLHttpRequest
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  ...args: Parameters<typeof open>
) {
  methods.set(this, String(args[0]).toUpperCase());
  return open.apply(this, args);
} as typeof open;

const send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (
  this: XMLHttpRequest,
  ...args: Parameters<typeof send>
) {
  this.addEventListener("loadend", () => {
    if (!this.responseURL) return;
    const start = performance.now();
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
    spent(start, 1);
  });
  return send.apply(this, args);
};
