import { decode, encode, now, type OutboxRecord, type Sample } from ".";
import { logger } from "@/lib/log";

const log = logger("perf");

// Raw samples in IndexedDB until exported (popup). Shared by every extension-origin context, so each writes its own
// flushes without messages. Separate from ./index: tests don't have IndexedDB.
// TODO upload: chrome.alarms in the SW -> read like exportOutbox, POST gzipped NDJSON (CompressionStream),
// deleteUpTo on 2xx.

const STORE = "outbox";
// environment records per context ("sw", "worker"), a new one when it changes, kept by deleteUpTo/clearOutbox, in every export
const META = "meta";
let db: Promise<IDBDatabase> | undefined;

function openIndexedDB(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("perf", 3);
    request.onupgradeneeded = ({ oldVersion }) => {
      const idb = request.result;
      if (oldVersion < 1) {
        idb.createObjectStore(STORE, {
          // generates each record's key itself
          autoIncrement: true,
        });
      }
      if (oldVersion < 3) {
        // v2 keyed meta by ctx, without autoIncrement: add() without a key fails there
        if (idb.objectStoreNames.contains(META)) idb.deleteObjectStore(META);
        idb.createObjectStore(META, { autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      // reopen on next use: a closed connection would fail every write
      request.result.onclose = () => (db = undefined);
      resolve(request.result);
    };
    request.onerror = () => {
      db = undefined;
      reject(request.error);
    };
  });
  return db;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Sink writing each flush as one record. `ctx`: where the samples were taken, e.g. "sw". */
export function outboxSink(context: string): (samples: Sample[]) => void {
  const instance = crypto.randomUUID().slice(0, 8);

  return (samples) => {
    (async () => {
      const tx = (await openIndexedDB()).transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(encode(samples, context, instance));
      await done(tx);
    })().catch(log.error);
  };
}

/** A context's environment (browser, device, model, ...), exported as one row named "meta". */
interface MetaRecord {
  ctx: string;
  t: number;
  meta: Record<string, unknown>;
}

/** Appends `ctx`'s environment unless it equals `ctx`'s last one: a new model or browser gets a new row. */
export async function writeMeta(ctx: string, meta: Record<string, unknown>) {
  // one readwrite transaction: two contexts starting at once can't both append
  const tx = (await openIndexedDB()).transaction(META, "readwrite");
  const store = tx.objectStore(META);
  const all = store.getAll();
  all.onsuccess = () => {
    let last: MetaRecord | undefined;
    for (const record of all.result as MetaRecord[])
      if (record.ctx === ctx) last = record;
    if (JSON.stringify(last?.meta) !== JSON.stringify(meta))
      store.add({ ctx, t: now(), meta } satisfies MetaRecord);
  };
  await done(tx);
}

/** Pseudonymous id of this install, in every exported row so testers' files can be merged. Created on first use. */
let id: Promise<string> | undefined;
export function installId(): Promise<string> {
  id ??= (async () => {
    const { installId } = await chrome.storage.local.get("installId");
    if (typeof installId === "string") return installId;
    const created = crypto.randomUUID();
    await chrome.storage.local.set({ installId: created });
    return created;
  })();
  return id;
}

// per file: the whole file is built in memory before download, so a big outbox goes out as several
const MAX_FILE_BYTES = 500e6;

/** Gzipped NDJSON of every meta record and the samples after `after` (from the start if unset), up to ~MAX_FILE_BYTES
 * uncompressed, each row with `install`, and the last key in it for `deleteUpTo` and the next call. No `lastKey`:
 * nothing left. Not `full`: this file reached the end. */
export async function exportOutbox(
  install: string,
  after?: IDBValidKey,
): Promise<{
  blob: Blob;
  lastKey?: IDBValidKey;
  full: boolean;
}> {
  const tx = (await openIndexedDB()).transaction([STORE, META]);
  // one Blob per record: Chrome can keep Blob data off the JS heap, unlike millions of strings
  const parts: Blob[] = [];
  let bytes = 0;
  let lastKey: IDBValidKey | undefined;
  // in every file, so each one can be matched on its own
  const metas = tx.objectStore(META).getAll();
  metas.onsuccess = () => {
    const rows = (metas.result as MetaRecord[]).map(({ ctx, t, meta }) =>
      JSON.stringify({ install, t, ctx, name: "meta", meta }),
    );
    parts.unshift(new Blob(rows.map((row) => row + "\n")));
  };
  let range: IDBKeyRange | undefined;
  if (after !== undefined) range = IDBKeyRange.lowerBound(after, true);
  const request = tx.objectStore(STORE).openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const rows = [...decode(cursor.value as OutboxRecord)].map((row) =>
      JSON.stringify({ install, ...row }),
    );
    const part = new Blob([rows.join("\n") + "\n"]);
    parts.push(part);
    lastKey = cursor.key;
    bytes += part.size;
    // not continuing ends the cursor, the transaction completes
    if (bytes < MAX_FILE_BYTES) cursor.continue();
  };
  // the transaction, not request.onerror: a throw in onsuccess aborts it without firing onerror, hanging the export
  await done(tx);
  const gzip = new Blob(parts)
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return {
    blob: await new Response(gzip).blob(),
    lastKey,
    full: bytes >= MAX_FILE_BYTES,
  };
}

/** Deletes up to and including `key`: what was exported, not what was written since. */
export async function deleteUpTo(key: IDBValidKey): Promise<void> {
  const tx = (await openIndexedDB()).transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(IDBKeyRange.upperBound(key));
  await done(tx);
}

export async function clearOutbox(): Promise<void> {
  const tx = (await openIndexedDB()).transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await done(tx);
}

/** Records in the outbox, and the origin's storage use in bytes. */
export async function outboxStats(): Promise<{
  records: number;
  bytes?: number;
}> {
  const tx = (await openIndexedDB()).transaction(STORE);
  const request = tx.objectStore(STORE).count();
  await done(tx);
  return {
    records: request.result,
    bytes: (await navigator.storage.estimate()).usage,
  };
}
