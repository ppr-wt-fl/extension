import { flags } from "@/lib/flags";
import { count, gauge, now, since } from "@/lib/perf";

// Requests already classified "allow", so a page load doesn't refetch, extract and classify them again. Blocked
// requests never complete, so they never come back here, and a block verdict drops its entry: if it got no rule
// (MAX_RULES), the request is classified again. Kept in storage.session, which survives the service worker
// stopping and is cleared on browser restart and on extension update, which is when the model changes.

/** Seconds since 2026-01-01, small enough for V8 to store unboxed (Smi, 2^30 s = 34 years). */
const EPOCH_S = 1_767_225_600;
export const nowS = () => Math.floor(Date.now() / 1000) - EPOCH_S;

export interface Entry {
  /** When the model last ran on it */
  classifiedAt: number;
  /** When it was last confirmed unchanged, by classifying it, its validator or its body */
  checkedAt: number;
  /** 30-bit hash of its response's validator, 0 if none */
  validator: number;
  /** 30-bit hash of its refetched body, 0 if none */
  body: number;
}

/** By 53-bit hash of its `ruleKey`, least recently used first. */
const entries = new Map<number, Entry>();
/** Keys being refetched or classified, so the same request completing twice is handled once. */
export const pending = new Set<number>();

/**
 * - inflight: the same request is being handled
 * - fresh: skip it. A URL-only request until `maxAgeMs`: its features only depend on its `ruleKey`
 * - needs-body-validation: compare its validator, then its body, with the ones it was classified with
 * - run-from-scratch: classify it, it's new or older than `maxAgeMs`
 */
export type Tier =
  | "inflight"
  | "fresh"
  | "needs-body-validation"
  | "run-from-scratch";

export function tier(key: number, hasBody: boolean, t = nowS()): Tier {
  if (pending.has(key)) return "inflight";

  const entry = entries.get(key);
  if (!entry || t - entry.classifiedAt > flags.cache.maxAgeMs / 1000)
    return "run-from-scratch";
  if (!hasBody || t - entry.checkedAt < flags.cache.freshMs / 1000)
    return "fresh";
  return "needs-body-validation";
}

export function get(key: number): Entry | undefined {
  return entries.get(key);
}

/** Sets an entry, as the most recently used. Past `maxEntries`, evicts the least recently used. */
export function put(key: number, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);

  if (entries.size > flags.cache.maxEntries) {
    entries.delete(entries.keys().next().value!);
    count("cache.evicted");
  }

  saveSoon();
}

/** Marks an entry as the most recently used. Doesn't save: losing the order on a restart only changes what's evicted. */
export function touch(key: number): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entries.set(key, entry);
}

/** Forgets every verdict, so every request is classified again. */
export async function clear(): Promise<void> {
  await ready();
  entries.clear();
  await chrome.storage.session.remove("checked");
}

export function drop(key: number): void {
  if (entries.delete(key)) saveSoon();
}

async function sha256(data: string | ArrayBuffer): Promise<DataView> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new DataView(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * 53-bit hash of a `ruleKey` (cyrb53), the most a number holds exactly: ~5e-7 expected collisions at 100k entries.
 * Synchronous, unlike crypto.subtle, so a cache hit doesn't wait a task. Not collision resistant against crafted URLs.
 */
export function hashRuleKey(ruleKey: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < ruleKey.length; i++) {
    const c = ruleKey.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (0x1f_ffff & h2) + (h1 >>> 0);
}

/** 30 bits of a hash, never 0. Only compared with the same key's previous one. */
export async function hash30(data: string | ArrayBuffer): Promise<number> {
  return (await sha256(data)).getUint32(0) >>> 2 || 1;
}

/**
 * What identifies a response's version: a strong ETag, else Last-Modified with Content-Length. A weak ETag (W/) only
 * promises equivalent content, a length alone nothing.
 */
export function validator(
  headers?: chrome.webRequest.HttpHeader[],
): string | undefined {
  const get = (name: string) =>
    headers?.find((h) => h.name.toLowerCase() === name)?.value;
  const etag = get("etag");
  if (etag && !etag.startsWith("W/")) return etag;
  const modified = get("last-modified");
  const length = get("content-length");
  return modified && length ? `${modified}|${length}` : undefined;
}

// Persistence: 6 u32 per entry (key high, key low, then the entry's fields), base64, since storage only takes JSON

const FIELDS = 6;
let loading: Promise<void> | undefined;

/** Loads the entries a previous service worker saved, once. */
export function ready(): Promise<void> {
  return (loading ??= load());
}

async function load(): Promise<void> {
  const start = now();
  const { checked } = await chrome.storage.session.get("checked");
  if (typeof checked !== "string") return;
  const u32 = new Uint32Array(
    Uint8Array.from(atob(checked), (c) => c.charCodeAt(0)).buffer,
  );
  for (let i = 0; i < u32.length; i += FIELDS) {
    entries.set(u32[i] * 2 ** 32 + u32[i + 1], {
      classifiedAt: u32[i + 2],
      checkedAt: u32[i + 3],
      validator: u32[i + 4],
      body: u32[i + 5],
    });
  }
  since("sw.cacheLoad", start);
}

let saving: ReturnType<typeof setTimeout> | undefined;

function saveSoon(): void {
  // a service worker stopped before it saves only loses some entries, which are checked again
  saving ??= setTimeout(() => {
    saving = undefined;
    save().catch(() => count("cache.saveFailed"));
  }, flags.cache.saveMs);
}

export async function save(): Promise<void> {
  const start = now();
  const oldest = nowS() - flags.cache.maxAgeMs / 1000;
  for (const [key, entry] of entries)
    if (entry.classifiedAt < oldest) entries.delete(key);
  const u32 = new Uint32Array(entries.size * FIELDS);
  let i = 0;
  for (const [key, e] of entries) {
    u32.set(
      [
        Math.floor(key / 2 ** 32),
        key >>> 0,
        e.classifiedAt,
        e.checkedAt,
        e.validator,
        e.body,
      ],
      i,
    );
    i += FIELDS;
  }
  const u8 = new Uint8Array(u32.buffer);
  let binary = "";
  // fromCharCode takes its arguments on the stack, so in chunks
  for (let j = 0; j < u8.length; j += 0x8000)
    binary += String.fromCharCode(...u8.subarray(j, j + 0x8000));
  await chrome.storage.session.set({ checked: btoa(binary) });
  gauge("cache.size", entries.size);
  since("sw.cacheSave", start);
}
