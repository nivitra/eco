/** Device-local recovery only. Authorization is checked online before a cache may be displayed.
 * AES-GCM protects the stored document; the nonextractable key lives in IndexedDB on this origin.
 * This does not protect against scripts executing in an already compromised application origin.
 */
const database = 'kulture-map-drafts-v1';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(database, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('records');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function record<T>(key: string, value?: unknown): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('records', value === undefined ? 'readonly' : 'readwrite'),
        store = tx.objectStore('records'),
        r = value === undefined ? store.get(key) : store.put(value, key);
      let result: unknown;
      r.onsuccess = () => {
        result = r.result;
      };
      tx.oncomplete = () => resolve(result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
let pendingKey: Promise<CryptoKey> | undefined;
function key() {
  return (pendingKey ??= (async () => {
    const existing = await record<CryptoKey>('key');
    if (existing) return existing;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await record('key', created);
    return created;
  })());
}
export async function saveMapRecovery(scope: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    data = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope) },
    await key(),
    data,
  );
  await record('draft:' + scope, { iv, ciphertext });
}
export async function loadMapRecovery<T>(scope: string): Promise<T | null> {
  const saved = await record<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }>(
    'draft:' + scope,
  );
  if (!saved) return null;
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: saved.iv, additionalData: new TextEncoder().encode(scope) },
    await key(),
    saved.ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}
