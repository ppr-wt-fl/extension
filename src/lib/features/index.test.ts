import { expect, test } from "vitest";
import { flags } from "../flags";
import {
  extract,
  featuresWasmBytes,
  inlineScripts,
  unknownNodeType,
  presets,
  type RequestInfo,
} from ".";

const request: RequestInfo = {
  url: "https://cdn.example.com/static/app.js",
  topLevelUrl: "https://www.example.com/",
  type: "script",
  body: "var a = localStorage.getItem('x'); fetch('https://t.example/'+a);",
};

test("rejects unknown names", () => {
  for (const name of ["nope", "req_url_200", "fqdn_30"]) {
    expect(() => extract([name], request), name).toThrow(
      `unknown feature ${name}`,
    );
  }
});

test("keeps order", () => {
  const forward = Array.from(extract(presets.adflush, request));
  const backward = Array.from(extract([...presets.adflush].reverse(), request));
  expect(backward).toEqual(forward.reverse());
});

test("mixes TS and Rust features", () => {
  const ts = new Map([
    ["url_has_query", (req: RequestInfo) => Number(req.url.includes("?"))],
  ]);
  const values = extract(
    ["url_length", "url_has_query", "is_third_party"],
    { ...request, url: "https://a.example/?q" },
    ts,
  );
  expect(Array.from(values)).toEqual([20, 1, 1]);
});

test("inlineScripts", () => {
  const html =
    '<script>a()</script>\r\n<script src="x.js"></script><script>\r\nb()\r\n</script>';
  expect(inlineScripts(html)).toEqual(["a()", "\nb()\n"]);
});

test("featuresWasmBytes is the linear memory, in 64 KiB pages", () => {
  const bytes = featuresWasmBytes()!;
  expect(bytes).toBeGreaterThan(0);
  expect(bytes % 65536).toBe(0);
});

// acorn-loose ASTs skip oxc, the parser that overflows
test.skipIf(import.meta.env.ACORN)(
  "recovers after deeply nested JS overflows the wasm stack",
  () => {
    const baseline = extract(presets.adflush, request);
    for (const body of [
      "(".repeat(1000) + "1" + ")".repeat(1000),
      "[".repeat(2000),
    ]) {
      expect(() => extract(presets.adflush, { ...request, body })).toThrow();
      expect(extract(presets.adflush, request)).toEqual(baseline);
    }
  },
);

test("class fields zero the JS features and set unknownNodeType", () => {
  const names = ["avg_charperline", "num_get_cookie"];
  const body = "var c = document.cookie;\n";
  const plain = extract(names, { ...request, body });
  expect(unknownNodeType()).toBe(false);
  const field = extract(names, { ...request, body: `class _{x=1}\n${body}` });
  expect(Array.from(plain)).not.toEqual([0, 0]);
  expect(Array.from(field)).toEqual([0, 0]);
  expect(unknownNodeType()).toBe(true);
  expect(unknownNodeType()).toBe(false); // read once
});

test("resets the wasm memory after an extract grows it past the flag", () => {
  const baseline = extract(presets.adflush, request);
  extract(presets.adflush, { ...request, body: "a;".repeat(1e6) });
  expect(featuresWasmBytes()!).toBeLessThan(flags.resetWasmBytes);
  expect(extract(presets.adflush, request)).toEqual(baseline);
});
