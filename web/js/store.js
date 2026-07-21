/**
 * 会话持久化层（IndexedDB，BUG-008）：素材/参考图/.cube/界面状态自动保存，
 * 刷新或重开浏览器后恢复工作区。全部数据仅存本地浏览器，符合"纯本地处理"承诺。
 * IDB 不可用时静默降级（应用照常运行，只是不持久）。
 */

const DB_NAME = 'tonesync';
const DB_VER = 1;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  })).catch((e) => { console.warn('[store]', e); return undefined; });
}

let ord = Date.now();

/** rec: {key?, kind:'img'|'ref'|'cube', name, blob?, data?, size?, weight?} → 返回 key */
export function putFile(rec) {
  rec.key = rec.key || `f${(++ord).toString(36)}`;
  rec.ord = rec.ord ?? ++ord;
  tx('files', 'readwrite', (s) => s.put(rec));
  return rec.key;
}

export function updateFile(key, patch) {
  return tx('files', 'readwrite', (s) => {
    const req = s.get(key);
    req.onsuccess = () => { if (req.result) s.put({ ...req.result, ...patch }); };
  });
}

export function deleteFile(key) {
  return tx('files', 'readwrite', (s) => s.delete(key));
}

export async function getAllFiles() {
  const rows = await tx('files', 'readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => a.ord - b.ord);
}

export function setKV(k, v) {
  return tx('kv', 'readwrite', (s) => s.put({ k, v }));
}

export async function getKV(k) {
  const row = await tx('kv', 'readonly', (s) => s.get(k));
  return row ? row.v : undefined;
}

export async function clearAll() {
  await tx('files', 'readwrite', (s) => s.clear());
  await tx('kv', 'readwrite', (s) => s.clear());
}
