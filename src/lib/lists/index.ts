import init, { Lists } from "../../../filterlists/pkg/filterlists.js";
import wasmUrl from "../../../filterlists/pkg/filterlists_bg.wasm?url";
import { now, since } from "@/lib/perf";

/** One engine per list, by file: filterlists/data/<name>.txt -> filterlists/pkg/<name>.dat */
const engineUrls = import.meta.glob<string>("../../../filterlists/pkg/*.dat", {
  query: "?url",
  import: "default",
  eager: true,
});

/** The names of the lists that block a request, empty if none. `type` is a chrome.webRequest resource type. */
export type Check = (req: {
  url: string;
  topLevelUrl: string;
  type: string;
}) => string[];

let memory: WebAssembly.Memory | undefined;

/** Bytes of the wasm module's linear memory, undefined before `loadLists`. */
export function listsWasmBytes(): number | undefined {
  return memory?.buffer.byteLength;
}

/** Loads the filter lists (filterlists/data), to compare the model's verdicts with. */
export async function loadLists(): Promise<Check> {
  const start = now();
  // in dev the urls are root-relative to the vite server, not the extension origin
  const url = (u: string) => new URL(u, import.meta.url);
  const [wasm, ...files] = await Promise.all([
    init({ module_or_path: url(wasmUrl) }),
    ...Object.entries(engineUrls).map(async ([path, u]) => {
      const bytes = new Uint8Array(await (await fetch(url(u))).arrayBuffer());
      return [path.split("/").pop()!.slice(0, -".dat".length), bytes] as const;
    }),
  ]);
  memory = wasm.memory;
  // after init: Lists needs the wasm
  const engines = files.map(
    ([name, bytes]) => [name, new Lists(bytes)] as const,
  );
  const check: Check = ({ url, topLevelUrl, type }) =>
    engines
      .filter(([, lists]) => lists.match(url, topLevelUrl, type))
      .map(([name]) => name);
  since("startup.lists", start);
  return check;
}
