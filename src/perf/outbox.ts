import { decode, encode, type OutboxRecord, type Sample } from ".";
import { logger } from "@/log";

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

/** Gzipped NDJSON of every sample, and the last key in it for `deleteUpTo`. */
export async function exportOutbox(): Promise<{
  blob: Blob;
  lastKey?: IDBValidKey;
}> {
  const tx = (await openIndexedDB()).transaction(STORE);
  // one Blob per record: Chrome can keep Blob data off the JS heap, unlike millions of strings
  const parts: Blob[] = [];
  let lastKey: IDBValidKey | undefined;
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const rows = [...decode(cursor.value as OutboxRecord)].map((row) =>
        JSON.stringify(row),
      );
      parts.push(new Blob([rows.join("\n") + "\n"]));
      lastKey = cursor.key;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const gzip = new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
  return {
    blob: await new Response(gzip).blob(),
    lastKey,
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
