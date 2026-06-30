/** Web Push opt-in for the Daybook PWA / Android TWA.
 *
 *  enablePush() — ask permission, create a PushSubscription with the server's
 *  VAPID key, and register it with the backend. Safe to call repeatedly.
 *  refreshPushIfGranted() — re-sync the subscription on login if already granted.
 */
import { api } from './api.js';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribeAndRegister() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('/push/vapid-public-key');
    if (!key) throw new Error('Push is not configured on the server yet');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return true;
}

// Full opt-in flow (call from a user gesture — e.g. a button).
export async function enablePush() {
  if (!pushSupported()) throw new Error('This device does not support notifications');
  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed');
  return subscribeAndRegister();
}

// On login, silently re-register the existing subscription if already granted
// (keeps the server's endpoint fresh; never prompts).
export async function refreshPushIfGranted() {
  try {
    if (pushSupported() && Notification.permission === 'granted') await subscribeAndRegister();
  } catch (_) { /* non-fatal */ }
}

// On logout, drop this device's subscription server-side.
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch (_) { /* ignore */ }
}
