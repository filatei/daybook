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

// ── Safe-area floors (mobile always-on + standalone) ─────────────────────────
// PR #2 only floored under display-mode:standalone. Production phones still
// drew under the status bar / home indicator when env()=0 and the page was a
// browser tab, custom tab, or a PWA that didn't match that media query.
// Always floor on ≤767px; also keep standalone class for desktop-width PWAs.
const syncSafeAreaClasses = () => {
  const root = document.documentElement;
  const mq = window.matchMedia;
  const standalone =
    (mq && (mq('(display-mode: standalone)').matches || mq('(display-mode: fullscreen)').matches)) ||
    window.navigator.standalone === true;
  const mobile = mq ? mq('(max-width: 767px)').matches : (window.innerWidth || 0) < 768;
  root.classList.toggle('is-standalone', !!standalone);
  root.classList.toggle('is-mobile-safe', !!mobile);
  // Inline vars beat stylesheet order races; desktop clears floors.
  root.style.setProperty('--safe-top-floor', mobile || standalone ? '28px' : '0px');
  root.style.setProperty('--safe-bottom-floor', mobile || standalone ? '24px' : '0px');
};
syncSafeAreaClasses();
window.addEventListener('resize', syncSafeAreaClasses);
try {
  if (window.matchMedia) {
    for (const q of ['(display-mode: standalone)', '(display-mode: fullscreen)', '(max-width: 767px)']) {
      const mql = window.matchMedia(q);
      if (mql.addEventListener) mql.addEventListener('change', syncSafeAreaClasses);
      else if (mql.addListener) mql.addListener(syncSafeAreaClasses);
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
