import type { RequestInfo } from "@/lib/features";

/**
 * Black box giving a request's training label: 1 to block, 0 to allow, undefined if it doesn't know, which leaves the
 * request out of training. The fallback for when the filter lists can't label it (src/offscreen/worker). Random for now: only simulates the training workload, which doesn't depend on the labels.
 */
export async function label(
  _req: Omit<RequestInfo, "body" | "acornAsts">,
): Promise<0 | 1 | undefined> {
  return Math.random() < 0.5 ? 1 : 0;
}
