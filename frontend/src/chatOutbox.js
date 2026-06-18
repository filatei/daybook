// Offline-first chat: queue outgoing DMs locally when the network drops and
// replay them on reconnect. The server dedupes on client_uid, so replaying is
// safe (a message sent twice is stored once) — chats deliver whether the sender
// was online or offline when they hit Send.
import { api, isNetErr } from './api.js';

const KEY = 'daybook_chat_outbox';

export const getChatOutbox = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (a) => { localStorage.setItem(KEY, JSON.stringify(a)); window.dispatchEvent(new Event('chat-outbox')); };

// Queue a message (payload must carry a client_uid for idempotent replay).
export function queueChat(tenant, payload) {
  const o = getChatOutbox();
  o.push({ tenant, payload, ts: Date.now() });
  save(o);
}
// Messages still pending for a given conversation (to render as "queued").
export const pendingChat = (tenant, toId) =>
  getChatOutbox().filter((i) => i.tenant === tenant && i.payload?.to === toId).map((i) => i.payload);

let syncing = false;
export async function syncChatOutbox() {
  if (syncing || !navigator.onLine) return 0;
  const o = getChatOutbox();
  if (!o.length) return 0;
  syncing = true;
  const remain = [];
  let sent = 0;
  for (const it of o) {
    try {
      await api('/chat/send' + (it.tenant ? `?tenant=${it.tenant}` : ''), { method: 'POST', body: it.payload });
      sent++;
    } catch (e) {
      if (isNetErr(e)) remain.push(it);                 // still offline → keep
      else console.warn('[chat] dropping unsyncable message:', e.message);  // server rejected → drop
    }
  }
  save(remain);
  syncing = false;
  if (sent) window.dispatchEvent(new Event('chat-synced'));
  return sent;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { syncChatOutbox(); });
  setInterval(() => { if (navigator.onLine) syncChatOutbox(); }, 15000);
}
