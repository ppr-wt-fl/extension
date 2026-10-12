import type { RequestInfo } from "@/features";

/**
 * Black box giving a request's training label: 1 to block, 0 to allow, undefined if it doesn't know, which leaves the
 * request out of training. Stub: knows nothing, so nothing is trained on yet.
 */
export async function label(_req: RequestInfo): Promise<0 | 1 | undefined> {
  return undefined;
}
