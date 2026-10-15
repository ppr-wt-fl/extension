import { flags } from "@/lib/flags";
import { literalUrlFilter, refererRule } from "@/lib/block";
import { logger } from "@/lib/log";
import { count, now, record, since } from "@/lib/perf";

const log = logger("refetch");

// Session rules outlive the service worker, its id counter doesn't: drop the Referer rules a killed worker left behind.
// Only refetch uses session rules.
const cleared = chrome.declarativeNetRequest
  .getSessionRules()
  .then((rules) =>
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((r) => r.id),
    }),
  )
  .catch(log.error);

let refererRuleId = 0;

/**
 * Downloads a URL again, for the body webRequest doesn't expose. It can differ from what the page got: this request
 * has another cache partition and, depending on SameSite, cookies. The Referer is set to the initiator's origin by a
 * session rule for the duration of the fetch.
 */
export async function refetch(
  url: string,
  initiator: string | undefined,
): Promise<ArrayBuffer | undefined> {
  const start = now();
  // shortcut: origin only, which is what the default strict-origin-when-cross-origin policy sends cross-origin; a
  // same-origin request or a page with another Referrer-Policy sent something else. Two sites refetching the same URL
  // at once both get one of the two Referers. After a redirect, the next hop has no Referer. Upgrade: read the real header in onSendHeaders (needs extraHeaders) and
  // keep it by requestId until onCompleted.
  const referer =
    initiator?.startsWith("http") && literalUrlFilter(url)
      ? `${initiator}/`
      : undefined;
  // concurrent refetches each need their own id; far fewer than 1000 run at once
  const ruleId = referer ? (refererRuleId = (refererRuleId % 1000) + 1) : 0;
  try {
    if (referer) {
      await cleared;
      // without the Referer the body may differ, but it's still worth fetching
      await chrome.declarativeNetRequest
        .updateSessionRules({ addRules: [refererRule(ruleId, url, referer)] })
        .catch(log.error);
    }
    // the timeout also aborts reading the body
    const response = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(flags.refetch.timeoutMs),
    });
    if (!response.ok) {
      log.debug("refetch failed", response.status, url);
      count("sw.refetchFailed");
      return undefined;
    }
    // a navigation can be a video or a PDF; a script runs whatever its type (S3 serves binary/octet-stream), so only skip clear binaries
    const type = response.headers.get("content-type");
    const length = Number(response.headers.get("content-length"));
    if (
      (type && /^(image|video|audio|font)\/|application\/pdf/i.test(type)) ||
      length > flags.refetch.maxBytes
    ) {
      log.debug("refetch skipped", type, length, url);
      count("sw.refetchSkipped");
      await response.body?.cancel();
      return undefined;
    }

    // decompressed: upper bound of extra traffic. Read in chunks, a body without Content-Length can be any size.
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > flags.refetch.maxBytes) {
        log.debug("refetch skipped", type, size, url);
        count("sw.refetchSkipped");
        return undefined; // leaving the loop cancels the stream
      }
      chunks.push(chunk);
    }
    const bytes = await new Blob(chunks).arrayBuffer();
    record("sw.refetchBytes", bytes.byteLength);
    since("sw.refetch", start);
    return bytes;
  } catch (error) {
    log.debug("refetch failed", error, url);
    count("sw.refetchFailed");
    return undefined;
  } finally {
    if (ruleId) {
      chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: [ruleId] })
        .catch(log.error);
    }
  }
}
