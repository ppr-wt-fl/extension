import init, {
  extract as rustExtract,
  inline_scripts,
  inspect,
  type InitInput,
} from "../../features/pkg/adflush_features.js";
import adflush from "../../features/presets/adflush.json";

/** The request a feature vector is computed for. */
export interface RequestInfo {
  url: string;
  topLevelUrl: string;
  /** chrome.webRequest resource type, e.g. "script", "sub_frame", "image" */
  type: string;
  /** Response body: JavaScript for "script", HTML for "sub_frame" and "main_frame". Only read by JS features. */
  body?: string;
  /**
   * acorn-loose ASTs of the body's scripts, to compute the JS features exactly like the Python pipeline
   * (see `extract` in features/pkg). Without them Rust parses the scripts with oxc.
   */
  acornAsts?: string[];
}

export type Feature = (req: RequestInfo) => number;

/** Feature lists of known models, in the order the model expects. */
export const presets: Record<string, readonly string[]> = { adflush };

/**
 * Features computed in TS, by name. All other names are computed in Rust (`features` in features/src/lib.rs).
 * Prefer Rust for features that also have to be computed offline over a crawl dataset.
 * Anything async (chrome APIs, fetching) belongs in gathering the RequestInfo, not here.
 */
export const tsFeatures = new Map<string, Feature>([
  // ['url_has_query', (req) => Number(req.url.includes('?'))],
]);

/** Loads the wasm module. Must have resolved before `extract`. */
export async function initRust(input: InitInput): Promise<void> {
  await init({ module_or_path: input });
}

/** The named features of a request, in the given order. Throws on unknown names. */
export function extract(
  names: readonly string[],
  req: RequestInfo,
  ts = tsFeatures,
): Float64Array {
  const rustNames = names.filter((name) => !ts.has(name));
  const rust = rustExtract(
    rustNames,
    req.url,
    req.topLevelUrl,
    req.type,
    req.body,
    req.acornAsts,
  );
  let next = 0;
  return Float64Array.from(
    names,
    (name) => ts.get(name)?.(req) ?? rust[next++],
  );
}

/** Intermediates behind the Rust features, for tests and debugging. */
export interface Inspection {
  fqdn: string;
  /** Every n-gram of the body by feature name (ng_A_B_C), not only the requested ones. */
  ngrams: Record<string, number>;
}

export function rustInspect(req: RequestInfo): Inspection {
  return JSON.parse(
    inspect(req.url, req.topLevelUrl, req.type, req.body, req.acornAsts),
  );
}

export { inline_scripts as inlineScripts };
