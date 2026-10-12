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
src/flags.ts             build-time feature flags
src/popup/               popup UI
src/background/          service worker: webRequest, refetches, chrome.debugger capture
src/content/             content scripts: fetch/XHR patch (MAIN world), relay to the background
src/collect/             Observation type, observe(): features, then classification in src/offscreen
src/model/               any tfjs Layers model: loading, predict(), gradient(), inspectModes()
src/offscreen/           offscreen document + worker: learner and verdicts, outlive the service worker
src/learn/               batches requests, classifies and trains on each batch, FedAvg rounds (flags.learn)
src/label/               label(): training labels, black box (stub)
src/features/            TS side of feature extraction: extract(), presets, TS features
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

MV3 webRequest doesn't expose response bodies, so they are collected in several ways. Each one produces an
`Observation` (`src/collect`). Its features go to the learner in the offscreen document's worker (`src/offscreen`),
which classifies it with the next batch and trains on it if it has a label:

| Source       | Where                          | Covers                                       | Body                                                    |
|--------------|--------------------------------|----------------------------------------------|---------------------------------------------------------|
| `webRequest` | `src/background/index.ts`      | every request from a tab                     | none, for types whose features don't read it            |
| `refetch`    | `src/background/index.ts`      | GET `script`, `sub_frame`, `main_frame`      | downloaded again; cache, cookies and Referer can differ |
| `patch`      | `src/content/patch.ts`         | the page's own `fetch`/XHR                   | the exact response the page got                         |
| `dom`        | `src/content/relay.ts`         | every frame, on `load`                       | `outerHTML`: the document after parsing and scripts      |
| `debugger`   | `src/background/debugger.ts`   | every request, behind `flags.debugger`       | the exact response, through the DevTools Protocol       |

External scripts (`<script src>`) are therefore captured by `refetch`, or by `debugger` when enabled. The fetch/XHR
patch doesn't see them. `patch.ts` runs in the page's JS world at `document_start` and must not import or export
anything at runtime: CRXJS then injects it as is, before the page's scripts. It posts its captures to `relay.ts`,
which forwards them to the background. The page can post the same messages, so `patch` data is untrusted.

`flags.debugger` is off by default. When on, it adds the `debugger` permission, and Chrome shows a "started
debugging this browser" banner on every tab.

## Features

The features follow the YOPO fork of AdFlush (`robustness-evaluation/YOPO`, branch `fix-crawled-data-processing`),
which matches the published AdFlush data. The 27 features of the AdFlush model are listed in
`features/presets/adflush.json`, in model order.

### Use

```ts
import { extract, initRust, inlineScripts, presets } from './features'

await initRust()

const values = extract(presets.adflush, {
  url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  topLevelUrl: 'https://www.theguardian.com/',
  type: 'script',               // chrome.webRequest resource type
  body: scriptText,
})                              // Float64Array in the order of presets.adflush
```

`body` is the JavaScript for `script` and the HTML for `sub_frame` and `main_frame`; other types ignore it.

### Matching the Python pipeline exactly

The AST features (`ng_*`, `avg_ident`) come from acorn-loose in Python. Without `acornAsts`, Rust parses the
scripts with oxc, which differs where acorn-loose has to recover: line-wrapped minified code (about 1–12% off),
JSON `<script>` blocks (far off) and broken code. For exact values, parse with acorn-loose 8.4.0 and pass the ASTs:

```ts
import { parse } from 'acorn-loose'

const scripts = type === 'script' ? [body] : inlineScripts(body)
const acornAsts = scripts.map((s) => {
  try {
    return JSON.stringify(parse(s, { ecmaVersion: 2022 }))
  } catch {
    return '' // BigInt literals make JSON.stringify throw; the script then gets no features, like in Python
  }
})
extract(presets.adflush, { url, topLevelUrl, type, body, acornAsts })
```

### Add a feature

A model is a list of feature names. Rust: add a match arm to `features` in `features/src/lib.rs` (the computation
goes in `url.rs`, `js.rs` or a new module). TypeScript: add an entry to `tsFeatures` in `src/features/index.ts`;
a name there takes precedence over Rust.

### Test

All tests run with vitest against the wasm build, through `src/features` like the extension uses it
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

## TODO

- Seed randomness for tests and offline experiments: make `Reservoir`'s random source injectable (`src/learn`,
  `Math.random` by default) and seed tfjs Dropout. Keep it unseeded in the extension, where a known seed lets a page
  predict which of its samples are replayed.
