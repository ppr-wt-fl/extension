/** Build-time feature flags. manifest.config.ts reads them too, so a flag can add permissions. */
export const flags = {
  /** Lowest console level logged (src/lib/log.ts). "trace": every observation, "debug": rule changes. */
  log: "info" as "trace" | "debug" | "info" | "warn" | "error" | "silent",
  /** On-device training of the local model (src/lib/learn), FedAvg-style rounds. */
  learn: {
    /**
     * Which weights classify:
     * - "local": the model being trained
     * - "global": the round's starting weights
     */
    inferWith: "local" as "local" | "global",
    /**
     * Mode of the training passes, for layers that act differently in training (Dropout, BatchNorm), see
     * `inspectModes`. Only changes the gradients, not the cost: verdicts always come from a separate inference pass.
     * - "inference": Dropout off, BatchNorm uses its stored statistics. The gradient is that of the exact function
     *   that classifies, but without Dropout's regularization the local model can overfit the few rows of a step
     * - "training": like model.fit, Dropout drops random units (AdFlush: 0.2, 0.5 before the output), so each
     *   gradient is noisier but regularized. BatchNorm would use and update the batch's statistics, which FedAvg
     *   updates leave out
     */
    trainMode: "inference" as "inference" | "training",
    /** Inference: a batch is classified when it has this many requests, */
    batchSize: 500,
    /** or this long after its first request arrived. Compute is ~2-5 ms per batch, so longer barely batches more. */
    idleMs: 20,
    /** Labeled rows per SGD step; rows short of a step wait for more, and are lost when the session ends. */
    miniBatchSize: 64,
    /** Rows per forward/backward pass, ~0.9 ms each. Waiting requests are classified between slices, so ~30 ms max wait. */
    sliceRows: 32,
    /** Mean-gradient SGD (summed loss / rows), and site clipping already bounds each step: a plain small step size. */
    learningRate: 0.01,
    /** Share of each step's rows that are replayed from earlier steps, against drifting to one site. */
    replayFraction: 0.15,
    /** Samples kept for replay, by reservoir sampling over every trained sample. */
    replayCapacity: 5000,
    /** Training samples per top-level site and round, so one page can't fill a round with its requests. */
    perSiteLimit: 100,
    /** L2 norm each site's summed gradient in a step is clipped to, so one page can only move a step so far. */
    siteClip: 1,
    /** L2 norm the round's update (local - global) is clipped to before it is sent. */
    updateClip: 10,
    /** SGD steps per round: ~1300 fresh rows, at most 100 per site (perSiteLimit), so a round spans >= 13 sites. */
    roundSteps: 20,
  },
  /** Skipping requests already classified "allow" (src/background/checked.ts). */
  cache: {
    enabled: true,
    /** A request with a body is skipped this long after its last check, then revalidated by its headers or body. */
    freshMs: 10 * 60_000,
    /** A request is classified again this long after it was, whatever its headers or body: the model may have changed. */
    maxAgeMs: 24 * 3_600_000,
    /** Least recently used evicted past this, ~60 B each in memory, 24 B in storage.session (10 MB quota). */
    maxEntries: 100_000,
    /** Delay before saving changes to storage.session, which batches them. */
    saveMs: 10_000,
  },
  /** Re-downloading a response body for the features (src/background/refetch.ts). */
  refetch: {
    /** Aborts the request, and reading its body, after this long. */
    timeoutMs: 10_000,
    /** Larger responses (by Content-Length, or counted while reading) are skipped. */
    maxBytes: 5_000_000,
  },
  /** Refetching, classifying and adding rules on sites disabled in the popup, though their allow rules override them. */
  processDisabledSites: false,
  /** Compares every verdict with EasyList + EasyPrivacy's (src/lib/lists) as lists.* perf counts. Needs perf. */
  lists: true,
  /** Perf metrics (src/lib/perf), raw in IndexedDB, exported from the popup. */
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
    flushMs: 5000,
  },
};
