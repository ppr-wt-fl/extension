/** Build-time feature flags. manifest.config.ts reads them too, so a flag can add permissions. */
export const flags = {
  /**
   * Capture response bodies with chrome.debugger (src/background/debugger.ts): the exact bytes the page got, for every
   * request type. Needs the debugger permission, and Chrome shows a "started debugging this browser" banner.
   */
  debugger: false,
  /**
   * Capture fetch/XHR responses by patching them in the page (src/content/patch.ts). Off: the script isn't injected and
   * the background drops captured_by_patch messages, which the page could still post.
   */
  patchWebpageRequests: false,
  /**
   * How the observations of one request (url, topLevelUrl, type) by different sources decide whether to block it:
   * - "canonical": the verdict on the body closest to what the page got (see `BODY_RANK` in src/collect)
   * - "any": block if any observation's verdict is block
   */
  reconcile: "canonical" as "canonical" | "any",
  /** Lowest console level logged (src/log.ts). "trace": every observation, "debug": rule changes and flips. */
  log: "info" as "trace" | "debug" | "info" | "warn" | "error" | "silent",
  /** On-device training of the local model (src/learn), FedAvg-style rounds. */
  learn: {
    /**
     * Which weights classify:
     * - "local": the model being trained, so the batch's single forward pass both classifies and trains
     * - "global": the round's starting weights, which costs a second forward pass once the local model has moved
     */
    inferWith: "local" as "local" | "global",
    /**
     * How a model whose layers act differently in training (Dropout, BatchNorm) is trained, see `inspectModes`:
     * - "inference": as it classifies, so the training pass also gives the verdicts
     * - "training": like model.fit, the verdicts then need a second, inference-mode pass
     */
    trainMode: "inference" as "inference" | "training",
    /** Sources a page can't forge. Not captured_by_patch: the page can post patch messages itself. */
    sources: ["webRequest", "refetch", "dom", "debugger"] as readonly string[],
    /** A batch is classified and trained on when it has this many requests, */
    batchSize: 500,
    /** or no request arrived for this long. */
    idleMs: 100,
    learningRate: 0.01,
    /** Share of each batch's training rows that are replayed from earlier batches, against drifting to one site. */
    replayFraction: 0.15,
    /** Samples kept for replay, by reservoir sampling over every trained sample. */
    replayCapacity: 5000,
    /** Training samples per top-level site and round, so one page can't fill a round with its requests. */
    perSiteLimit: 100,
    /** L2 norm each site's summed gradient in a batch is clipped to, so one page can only move a step so far. */
    siteClip: 1,
    /** Rows per forward/backward pass. Events run between chunks, so smaller chunks keep the worker responsive. */
    chunkSize: 50,
    /** L2 norm the round's update (local - global) is clipped to before it is sent. */
    updateClip: 10,
    /** SGD steps (batches with training rows) per round. */
    roundSteps: 50,
  },
  /** Perf metrics (src/perf), raw in IndexedDB, exported from the popup. */
  perf: {
    /** Adds unlimitedStorage + declarativeNetRequestFeedback (rule hits) permissions. */
    enabled: true,
    /** User Timing entries for traces. Never cleared, so off. */
    trace: false,
    /** Training metrics (fl.*). Local/global disagreement costs 2nd forward pass. Off until labels exist. */
    fl: false,
    /** Samples a context buffers while it has no sink, oldest dropped. */
    maxBuffer: 10_000,
    /** Every context's buffer time before writing it to IndexedDB. */
    flushMs: 1000,
  },
};
