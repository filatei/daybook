import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

// ── Service worker: register + auto-reload on update ──────────────────────────
// The SW calls skipWaiting() on install, so a new worker activates immediately.
// When it takes over it fires 'controllerchange' — we reload so users run the
// latest JS bundle without having to manually refresh.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return; // guard against double-fire
        refreshing = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}

// ── PWA install prompt capture ────────────────────────────────────────────────
// Android Chrome only shows the install mini-infobar automatically after
// several visits. After uninstalling, the heuristic resets and Chrome won't
// prompt again for days. By capturing beforeinstallprompt we can show our own
// "Install App" button immediately, so reinstalling is always one tap away.
window.__pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // suppress the browser's automatic mini-infobar
  window.__pwaInstallPrompt = e;
  window.dispatchEvent(new CustomEvent('pwa-installable'));
});
window.addEventListener('appinstalled', () => {
  window.__pwaInstallPrompt = null;
  window.dispatchEvent(new CustomEvent('pwa-installed'));
});
