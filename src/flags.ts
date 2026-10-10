/** Build-time feature flags. manifest.config.ts reads them too, so a flag can add permissions. */
export const flags = {
  /**
   * Capture response bodies with chrome.debugger (src/background/debugger.ts): the exact bytes the page got, for every
   * request type. Needs the debugger permission, and Chrome shows a "started debugging this browser" banner.
   */
  debugger: false,
  /**
   * How the observations of one request (url, topLevelUrl, type) by different sources decide whether to block it:
   * - "canonical": the verdict on the body closest to what the page got (see `BODY_RANK` in src/collect)
   * - "any": block if any observation's verdict is block
   */
  reconcile: "canonical" as "canonical" | "any",
};
