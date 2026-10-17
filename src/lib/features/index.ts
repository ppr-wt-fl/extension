// static: service workers can't import()
import { parse as acornLooseParse } from "acorn-loose";
import init, {
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
   * acorn-loose ASTs of the body's scripts (see `extract` in features/pkg). With `flags.acorn`, `extract` and
   * `rustInspect` parse them with `acornAsts` when missing; otherwise Rust parses the scripts with oxc.
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

/**
 * acorn-loose ASTs like AdFlush's ast_parser.js, which the model was trained on: one for "script", one per
 * inline script for "sub_frame" and "main_frame", "" where it throws. Undefined for other types.
 */
export function acornAsts(req: RequestInfo): string[] | undefined {
  // flags.acorn as a constant from vite.config.ts, so without it the bundle drops acorn-loose
  if (!import.meta.env.ACORN) return undefined;
  let scripts: string[];
  if (req.type === "script") scripts = [req.body ?? ""];
  else if (req.type === "sub_frame" || req.type === "main_frame")
    scripts = inline_scripts(req.body ?? "");
  else return undefined;
  return scripts.map((script) => {
    try {
      return JSON.stringify(acornLooseParse(script, { ecmaVersion: 2022 }));
    } catch {
      // stack overflow, or JSON.stringify on a BigInt literal
      return "";
    }
  });
}

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
  const rust = rustExtract(
    rustNames,
    req.url,
    req.topLevelUrl,
    req.type,
    req.body,
    req.acornAsts ?? acornAsts(req),
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
    inspect(
      req.url,
      req.topLevelUrl,
      req.type,
      req.body,
      req.acornAsts ?? acornAsts(req),
    ),
  );
}

export { inline_scripts as inlineScripts };
