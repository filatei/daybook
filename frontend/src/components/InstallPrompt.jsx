import React, { useEffect, useState } from 'react';
import { InstallBanner, isStandalone } from './InstallLanding.jsx';

/**
 * Shows InstallBanner when a push click (or ?install=1) set the session flag.
 * Self-contained so it works on the login screen and inside the signed-in shell.
 */
export default function InstallPrompt() {
  const [show, setShow] = useState(() => {
    try {
      if (isStandalone()) return false;
      const q = new URLSearchParams(window.location.search);
      if (q.get('install') === '1' || q.get('action') === 'install') return true;
      return sessionStorage.getItem('daybook_prompt_install') === '1';
    } catch { return false; }
  });

  useEffect(() => {
    if (isStandalone()) { setShow(false); return; }
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get('install') === '1' || q.get('action') === 'install') {
        sessionStorage.setItem('daybook_prompt_install', '1');
        setShow(true);
      } else if (sessionStorage.getItem('daybook_prompt_install') === '1') {
        setShow(true);
      }
    } catch { /* ignore */ }
  }, []);

  if (!show) return null;
  return <InstallBanner onDismiss={() => setShow(false)} />;
}
