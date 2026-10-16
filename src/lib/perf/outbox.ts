import { decode, encode, type OutboxRecord, type Sample } from ".";
import { logger } from "@/lib/log";

const log = logger("perf");

// Raw samples in IndexedDB until exported (popup). Shared by every extension-origin context, so each writes its own
// flushes without messages. Separate from ./index: tests don't have IndexedDB.
// TODO upload: chrome.alarms in the SW -> read like exportOutbox, POST gzipped NDJSON (CompressionStream),
// deleteUpTo on 2xx.

const STORE = "outbox";
let db: Promise<IDBDatabase> | undefined;

function openIndexedDB(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("perf", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, {
        // generates each record's key itself
        autoIncrement: true,
      });
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

// per file: the whole file is built in memory before download, so a big outbox goes out as several
const MAX_FILE_BYTES = 500e6;

/** Gzipped NDJSON of the samples after `after` (from the start if unset), up to ~MAX_FILE_BYTES uncompressed, and
 * the last key in it for `deleteUpTo` and the next call. No `lastKey`: nothing left. Not `full`: this file reached the end. */
export async function exportOutbox(after?: IDBValidKey): Promise<{
  blob: Blob;
  lastKey?: IDBValidKey;
  full: boolean;
}> {
  const tx = (await openIndexedDB()).transaction(STORE);
  // one Blob per record: Chrome can keep Blob data off the JS heap, unlike millions of strings
  const parts: Blob[] = [];
  let bytes = 0;
  let lastKey: IDBValidKey | undefined;
  let range: IDBKeyRange | undefined;
  if (after !== undefined) range = IDBKeyRange.lowerBound(after, true);
  const request = tx.objectStore(STORE).openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const rows = [...decode(cursor.value as OutboxRecord)].map((row) =>
      JSON.stringify(row),
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
  const gzip = new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
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
