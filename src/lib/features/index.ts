import init, {
  __wbg_reset_state,
  extract as rustExtract,
  inline_scripts,
  inspect,
  type InitInput,
} from "../../../features/pkg/adflush_features.js";
import adflush from "../../../features/presets/adflush.json";

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

let memory: WebAssembly.Memory | undefined;

/** Loads the wasm module. Must have resolved before `extract`. */
export async function initRust(input: InitInput): Promise<void> {
  memory = (await init({ module_or_path: input })).memory;
}

/** Bytes of the wasm module's linear memory, undefined before `initRust`. */
export function featuresWasmBytes(): number | undefined {
  return memory?.buffer.byteLength;
}

/** The named features of a request, in the given order. Throws on unknown names. */
export function extract(
  names: readonly string[],
  req: RequestInfo,
  ts = tsFeatures,
): Float64Array {
  const rustNames = names.filter((name) => !ts.has(name));
  let rust: Float64Array;
  try {
    rust = rustExtract(
      rustNames,
      req.url,
      req.topLevelUrl,
      req.type,
      req.body,
      req.acornAsts,
    );
  } catch (e) {
    // A trap (e.g. stack overflow on deeply nested JS) leaves the instance poisoned, so every later call would fail
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
      __wbg_reset_state();
      // init returns the new instance once one exists; drop the old memory so it can be freed
      void init().then((out) => {
        memory = out.memory;
      });
    }
    throw e;
  }
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
