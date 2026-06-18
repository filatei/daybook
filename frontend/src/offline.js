// Offline-first POS: queue sales locally when the network drops and replay them
// on reconnect. The server dedupes on client_uid, so replaying is safe (a sale
// sent twice is recorded once). MT5's "keep working when the link is down" trait.
import { api, isNetErr } from './api.js';

const KEY = 'daybook_pos_outbox';

export const getOutbox = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const saveOutbox = (a) => { localStorage.setItem(KEY, JSON.stringify(a)); window.dispatchEvent(new Event('pos-outbox')); };
export const outboxCount = () => getOutbox().length;

// Queue a sale payload (must carry a client_uid for idempotent replay).
export function queueSale(tenant, payload) {
  const o = getOutbox();
  o.push({ tenant, payload, ts: Date.now() });
  saveOutbox(o);
}

let syncing = false;
// Replay queued sales. Keeps a sale on a network error (try again later); drops it
// only on a definitive server rejection (e.g. 4xx — bad data that won't fix itself).
export async function syncOutbox() {
  if (syncing || !navigator.onLine) return 0;
  const o = getOutbox();
  if (!o.length) return 0;
  syncing = true;
  const remain = [];
  let synced = 0;
  for (const it of o) {
    try {
      await api('/pos/sales' + (it.tenant ? `?tenant=${it.tenant}` : ''), { method: 'POST', body: it.payload });
      synced++;
    } catch (e) {
      if (isNetErr(e)) remain.push(it);             // still offline → keep
      else console.warn('[pos] dropping unsyncable sale:', e.message);  // server rejected → drop
    }
  }
  saveOutbox(remain);
  syncing = false;
  return synced;
}

// Auto-sync: on reconnect and on a slow poll while the app is open.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { syncOutbox(); });
  setInterval(() => { if (navigator.onLine) syncOutbox(); }, 20000);
}
