# Blocker extension

Chrome extension for ML-based ad and tracker blocking, built with React, TypeScript, Vite and CRXJS.
Request features are computed in Rust (`features/`), compiled to wasm with wasm-bindgen.

## Quick start

Building needs the wasm target and a wasm-bindgen CLI with exactly the version of the `wasm-bindgen` crate in
`features/Cargo.toml` (0.2.126):

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126
```

Then:

```sh
bun install
bun run build:features   # Rust features -> features/pkg
bun run dev              # development server
bun run build            # production build into dist/, includes build:features
bun run test             # vitest, includes build:features
```

Load the extension in Chrome: open `chrome://extensions/`, enable "Developer mode" and load the unpacked `dist` directory.

## Project structure

```
manifest.config.ts       extension manifest
src/lib/flags.ts         build-time feature flags
src/popup/               popup UI
src/background/          service worker: webRequest, refetches
src/lib/collect/         Observation type, observe(): features, then classification in src/offscreen
src/model/               any tfjs Layers model: loading, predict(), gradient(), inspectModes()
src/offscreen/           offscreen document + worker: learner and rule ids, outlive the service worker
src/lib/block/           dynamic block rules: applies the worker's rule changes, restores them to a new worker
src/lib/learn/           batches requests, classifies and trains on each batch, FedAvg rounds (flags.learn)
src/lib/label/           label(): training labels, black box (stub)
src/lib/perf/            performance metrics: record() in every context, aggregated in the offscreen worker
bench/                   page load with and without the extension, plus its metrics (Puppeteer + CDP)
src/lib/features/        TS side of feature extraction: extract(), presets, TS features
features/                Rust feature extraction
  src/lib.rs             maps feature names to values (features()); wasm API: extract(), inline_scripts(), inspect()
  src/url.rs             URL features: content_policy_type, url_length, is_third_party, keyword_raw_present,
                         req_url_N / fqdn_N character embeddings, tldextract port
  src/js.rs              JS/HTML features: ng_A_B_C, avg_ident, avg_charperline, brackettodot, num_* regex counts
  data/                  word vectors, content type and AST token dicts (from AdFlush/source/json),
                         public suffix list (tldextract 5.1.2 snapshot)
  presets/               feature lists of models, in model order
  tests/                 reference.py (original Python code) and compare.test.ts (Rust vs Python, via the wasm)
  pkg/                   wasm-bindgen output, generated
```

## Capturing requests

MV3 webRequest doesn't expose response bodies, so the background downloads them again. Each one produces an
`Observation` (`src/lib/collect`). Its features go to the learner in the offscreen document's worker (`src/offscreen`),
which classifies it with the next batch and trains on it if it has a label:

| Source       | Where                        | Covers                                  | Body                                                    |
| ------------ | ---------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `webRequest` | `src/background/index.ts`    | every request from a tab                | none, for types whose features don't read it            |
| `refetch`    | `src/background/index.ts`    | GET `script`, `sub_frame`, `main_frame` | downloaded again; cache, cookies and Referer can differ |
Only sources a page can't forge are used. Page-side capture (a fetch/XHR patch, the frames' `outerHTML`) was
removed: any script on the page can tamper with it. `chrome.debugger` was removed too: it needs the `debugger`
permission and shows a banner on every tab.

## Features

The features follow the YOPO fork of AdFlush (`robustness-evaluation/YOPO`, branch `fix-crawled-data-processing`),
which matches the published AdFlush data. The 27 features of the AdFlush model are listed in
`features/presets/adflush.json`, in model order.

### Use

```ts
import { extract, initRust, inlineScripts, presets } from "./features";

await initRust();

const values = extract(presets.adflush, {
  url: "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  topLevelUrl: "https://www.theguardian.com/",
  type: "script", // chrome.webRequest resource type
  body: scriptText,
}); // Float64Array in the order of presets.adflush
```

`body` is the JavaScript for `script` and the HTML for `sub_frame` and `main_frame`; other types ignore it.

### Matching the Python pipeline exactly

The AST features (`ng_*`, `avg_ident`) come from acorn-loose in Python. Without `acornAsts`, Rust parses the
scripts with oxc, which differs where acorn-loose has to recover: line-wrapped minified code (about 1–12% off),
JSON `<script>` blocks (far off) and broken code. For exact values, parse with acorn-loose 8.4.0 and pass the ASTs:

```ts
import { parse } from "acorn-loose";

const scripts = type === "script" ? [body] : inlineScripts(body);
const acornAsts = scripts.map((s) => {
  try {
    return JSON.stringify(parse(s, { ecmaVersion: 2022 }));
  } catch {
    return ""; // BigInt literals make JSON.stringify throw; the script then gets no features, like in Python
  }
});
extract(presets.adflush, { url, topLevelUrl, type, body, acornAsts });
```

### Add a feature

A model is a list of feature names. Rust: add a match arm to `features` in `features/src/lib.rs` (the computation
goes in `url.rs`, `js.rs` or a new module). TypeScript: add an entry to `tsFeatures` in `src/lib/features/index.ts`;
a name there takes precedence over Rust.

### Test

All tests run with vitest against the wasm build, through `src/lib/features` like the extension uses it
(`vitest.config.ts`, tests in `src/**/*.test.ts` and `features/tests/*.test.ts`):

```sh
bun run test                       # acorn path must match the Python reference exactly
OXC=1 bun run test                 # also lists where the oxc path differs
EXPECTED=other.json bun run test   # check another fixture
```

Intermediates that are not features (the fqdn string, every n-gram rather than the requested ones) are
checked through the `inspect` export (`rustInspect` in TS).

`features/tests/fixtures/expected.json` is generated by `features/tests/reference.py`, which runs the original code:
YOPO's `adflush_encodings.py`, `MY_embedding.extract_fqdn`, WebGraph's `content.py` and `get_domain`, and
acorn-loose through `ast_parser.js`. It needs node/npm and Python 3.8, the version of YOPO's AdFlush environment.
In `features/`:

```sh
uv venv -p 3.8 .venv
uv pip install -p .venv/bin/python tldextract==5.1.2 beautifulsoup4 numpy==1.21.6 pandas tqdm gensim scikit-learn six
.venv/bin/python tests/reference.py --yopo ../../robustness-evaluation/YOPO \
    tests/fixtures/expected.json tests/fixtures/js/* tests/fixtures/html/*
```

Every `.js` file becomes a `script` case and every `.html` file a `sub_frame` case, so any directory of
scripts and pages can be compared by writing its fixture elsewhere and running with `EXPECTED`.

### Differences from the Python pipeline

- `num_get_storage`, `num_set_storage`, `num_get_cookie` and `num_requests_sent` are AdFlush's static regex counts.
  YOPO trains on WebGraph's runtime counts (OpenWPM instrumentation) under these names, which can't be computed
  from the response body.
- Characters without a word vector are skipped; Python drops the whole row.
- An unknown content type gives NaN; YOPO drops the row.
- Domains use the suffix list bundled with tldextract 5.1.2; YOPO's WebGraph environment doesn't pin tldextract.
- Inline scripts are found with a regex that follows Python 3.8's html.parser (`</script>` ends a script,
  comments are skipped), not with BeautifulSoup itself.

## Performance

Behind `flags.perf` (`src/lib/flags.ts`). Every context records samples with `record`/`since`/`count` (`src/lib/perf`) and
every `flushMs` writes them raw, with timestamps, to IndexedDB (`perf`/`outbox`, `src/lib/perf/outbox.ts`): one record
per flush, names interned per record. The service worker and the offscreen worker write their own, content scripts
message the service worker. The popup exports the outbox as gzipped NDJSON (`.ndjson.gz`, `{t, ctx, instance, name, value}` per line) and
clears it; aggregation (percentiles etc.) happens offline. Upload to a server is a TODO in `src/lib/perf/outbox.ts`.

- Latency: `sw.timeToRule` (request completed until its block rule is active, the request's repeats load until
  then), `sw.timeToVerdict`, and its stages: `sw.eventDelay`, `sw.topLevelUrl`, `sw.refetch`, `sw.ready`,
  `sw.features.<type>`, `hop.*` (SW → offscreen → worker → SW), `learner.queueWait`, `learner.train`/`infer`/`batch`,
  `worker.handle`, `sw.ruleFlush`
- Blocking: `block.hits` (rules that blocked, needs declarativeNetRequestFeedback, unpacked only), `rules.added` (each
  one's request loaded first), `block.loadedDespiteRule`, `sw.requestsCompleted`
  (`block.hits / (block.hits + sw.requestsCompleted)` = share blocked); gauge `rules` and, in the popup,
  `rules.installed` against `rules.cap`
- Memory: gauges `tf.numTensors`/`tf.numBytes` (leaks), `learner.*`, sampled by the worker every
  `flushMs`
- Startup: `startup.*` in the worker, `sw.offscreenCreate`, counters `sw.starts`, `browser.starts`, `offscreen.creations`
- Page: `sw.refetchBytes`
- Cache (`src/background/checked.ts`): `cache.{fresh,needs-body-validation,run-from-scratch,inflight}` per request, `cache.validatorHit`/`bodyHit`
  (validated without classifying), `cache.evicted`, gauge `cache.size`, `sw.cacheLoad`/`sw.cacheSave`
- Training (`flags.perf.fl`, off): `fl.loss`, `fl.siteGradNorm`/`siteClipped`, `fl.updateNorm`/`updateClipped`,
  `fl.rejected*`, `fl.roundMs`, `fl.roundRows`, `fl.updateBytes`, `fl.disagreement` (local vs global verdicts, a
  second forward pass). Secret sharing metrics are TODOs at `SendUpdate` in `src/lib/learn`.

```sh
bun run build
bun run bench -- --runs 10 --warmup 2 --cpu 4 http://localhost:8000/page.html   # CHROME=... for another binary
```

## TODO

- Seed randomness for tests and offline experiments: make `Reservoir`'s random source injectable (`src/lib/learn`,
  `Math.random` by default) and seed tfjs Dropout. Keep it unseeded in the extension, where a known seed lets a page
  predict which of its samples are replayed.
