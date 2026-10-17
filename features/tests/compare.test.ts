// Compares the Rust features with the ones computed by the original Python code (tests/reference.py).
// Another fixture can be checked with EXPECTED=path/to/expected.json bun run test

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  extract,
  presets,
  rustInspect,
  type RequestInfo,
} from "../../src/lib/features";
import { flags } from "../../src/lib/flags";

interface Case {
  name?: string;
  url: string;
  top_level_url: string;
  content_policy_type: string;
  body: string;
  acorn_asts: string[];
  expected: Record<string, any>;
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1);
}

const number = (value: unknown) =>
  typeof value === "number" ? value : undefined;

function compare(useAcorn: boolean): string[] {
  const names = presets.adflush;
  const embedding = Array.from({ length: 200 }, (_, i) => `req_url_${i}`);
  const path =
    process.env.EXPECTED ?? new URL("fixtures/expected.json", import.meta.url);
  const cases: Case[] = JSON.parse(readFileSync(path, "utf8"));
  const failures: string[] = [];

  for (const c of cases) {
    const name = c.name ?? c.url;
    const expected = c.expected;
    const req: RequestInfo = {
      url: c.url,
      topLevelUrl: c.top_level_url,
      type: c.content_policy_type,
      body: c.body,
      acornAsts: useAcorn ? c.acorn_asts : undefined,
    };

    const got = extract(names, req);
    names.forEach((feature, i) => {
      const reqUrl = feature.match(/^req_url_(\d+)$/);
      const fqdn = feature.match(/^fqdn_(\d+)$/);
      const want = reqUrl
        ? number(expected.req_url?.[Number(reqUrl[1])])
        : fqdn
          ? number(expected.fqdn_vec?.[Number(fqdn[1])])
          : feature.startsWith("ng_")
            ? (number(expected.ngrams[feature]) ?? 0)
            : number(expected[feature]);
      const ok =
        want !== undefined
          ? close(got[i], want)
          : feature === "content_policy_type"
            ? // content_policy_type without encoding
              Number.isNaN(got[i])
            : // Python throws on characters without embedding
              true;
      if (!ok)
        failures.push(`${name}: ${feature} rust=${got[i]} python=${want}`);
    });

    const inspection = rustInspect(req);
    if (inspection.fqdn !== expected.fqdn) {
      failures.push(
        `${name}: fqdn rust=${inspection.fqdn} python=${expected.fqdn}`,
      );
    }
    if (Array.isArray(expected.req_url)) {
      const gotEmbedding = extract(embedding, req);
      if (
        expected.req_url.some(
          (w: number, i: number) => !close(gotEmbedding[i], w),
        )
      ) {
        failures.push(`${name}: req_url embedding differs`);
      }
    }

    // all n-grams, not only the 6 the model uses
    const want: Record<string, number> = expected.ngrams;
    const keys = new Set([
      ...Object.keys(want),
      ...Object.keys(inspection.ngrams),
    ]);
    const mismatched = [...keys].filter(
      (k) => !close(inspection.ngrams[k] ?? 0, want[k] ?? 0),
    );
    if (mismatched.length > 0)
      failures.push(`${name}: ${mismatched.length} n-grams differ`);
  }

  console.log(`${cases.length} cases, ${failures.length} mismatches`);
  return failures;
}

test("acorn AST matches Python", () => {
  const failures = compare(true);
  expect(failures, failures.join("\n")).toEqual([]);
});

// production passes no ASTs: extract parses them with the bundled acorn-loose, or oxc without flags.acorn
test.skipIf(!flags.acorn)("bundled acorn-loose matches Python", () => {
  const failures = compare(false);
  expect(failures, failures.join("\n")).toEqual([]);
});
