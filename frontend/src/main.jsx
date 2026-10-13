import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// ── Visible-height shim ──────────────────────────────────────────────────────
// #root's height uses var(--appvh): 100vh/100dvh over-measure inside in-app
// webviews and some standalone contexts, which pushed the in-flow bottom nav
// off-screen. window.innerHeight is the actually-visible height everywhere;
// keep it fresh across URL-bar collapse, rotation and keyboard.
const setAppVh = () => {
  document.documentElement.style.setProperty('--appvh', window.innerHeight + 'px');
};
setAppVh();
window.addEventListener('resize', setAppVh);
if (window.visualViewport) window.visualViewport.addEventListener('resize', setAppVh);

// ── Standalone / edge-to-edge class ──────────────────────────────────────────
// CSS @media (display-mode: standalone) covers most PWAs; also set a class for
// iOS navigator.standalone and keep it in sync if display-mode changes. Styles
// use html.is-standalone to floor safe-area padding when env() reports 0.
const syncStandaloneClass = () => {
  const standalone =
    (window.matchMedia && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches
    )) ||
    window.navigator.standalone === true;
  document.documentElement.classList.toggle('is-standalone', !!standalone);
};
syncStandaloneClass();
try {
  if (window.matchMedia) {
    for (const q of ['(display-mode: standalone)', '(display-mode: fullscreen)']) {
      const mql = window.matchMedia(q);
      if (mql.addEventListener) mql.addEventListener('change', syncStandaloneClass);
      else if (mql.addListener) mql.addListener(syncStandaloneClass);
    }
  }
} catch { /* ignore */ }

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
