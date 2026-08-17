import React, { useEffect, useState } from 'react';
import { useStore } from '../store.jsx';
import { pushSupported, pushPermission, enablePush } from '../push.js';
import { isStandalone } from './InstallLanding.jsx';

const SNOOZE_KEY = 'daybook_push_snooze';
const SNOOZE_MS = 14 * 86400000;

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return until && Date.now() < until;
  } catch { return false; }
}

/** Banner after login asking to enable native PWA notifications. */
export default function PushPrompt() {
  const { toast } = useStore();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return;
    if (pushPermission() !== 'default') return;
    if (snoozed()) return;
    setShow(true);
  }, []);

  if (!show) return null;

  const iosHint = /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !isStandalone();

  const dismiss = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* ignore */ }
    setShow(false);
  };

  const enable = async () => {
    setBusy(true);
    try {
      await enablePush();
      toast('Notifications enabled', 'ok');
      setShow(false);
    } catch (e) {
      toast(e.message || 'Could not enable notifications', 'err');
    }
    setBusy(false);
  };

  return (
    <div className="push-banner">
      <div className="push-banner-ic">🔔</div>
      <div className="push-banner-copy">
        <div className="push-banner-t">Turn on notifications</div>
        <div className="push-banner-s">
          {iosHint
            ? 'Add Daybook to your Home Screen first, then enable alerts for reports, expenses and chat.'
            : 'Get alerts on this device for reports, expenses and chat — even when the app is closed.'}
        </div>
      </div>
      <div className="push-banner-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss} disabled={busy}>Later</button>
        {!iosHint && (
          <button type="button" className="btn btn-sm" onClick={enable} disabled={busy}>
            {busy ? <span className="spin" /> : 'Enable'}
          </button>
        )}
      </div>
    </div>
  );
}
