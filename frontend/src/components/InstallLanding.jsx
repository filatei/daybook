import React, { useEffect, useState } from 'react';

// True when the app is already running as an installed PWA (standalone), so we
// never show the install prompt to someone who already has the app.
export const isStandalone = () =>
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');

// Shown when someone opens a receipt's QR link (daybook.torama.money/?r=NNNN) in
// a phone browser without the app installed. Prompts them to install Daybook.
export default function InstallLanding({ receipt, onContinue }) {
  const [canInstall, setCanInstall] = useState(() => !!window.__pwaInstallPrompt);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const on = () => setCanInstall(true);
    const done = () => onContinue();
    window.addEventListener('pwa-installable', on);
    window.addEventListener('pwa-installed', done);
    return () => { window.removeEventListener('pwa-installable', on); window.removeEventListener('pwa-installed', done); };
  }, [onContinue]);

  const install = async () => {
    const p = window.__pwaInstallPrompt;
    if (!p) return;
    setInstalling(true);
    try { p.prompt(); await p.userChoice; window.__pwaInstallPrompt = null; } catch { /* dismissed */ }
    setInstalling(false);
  };

  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--brand)' }}>
      <div className="card pop-in" style={{ width: '100%', maxWidth: 420, textAlign: 'center', padding: '28px 22px' }}>
        <div style={{ fontSize: 40 }}>📒</div>
        <h2 style={{ margin: '8px 0 2px' }}>Daybook</h2>
        {receipt && <p style={{ color: 'var(--muted)', marginTop: 0 }}>Receipt #{String(receipt).padStart(4, '0')}</p>}
        <p style={{ fontSize: 14, color: 'var(--ink)' }}>
          Install the Daybook app to verify this receipt, track your orders and get the full experience.
        </p>

        {canInstall ? (
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={install} disabled={installing}>
            {installing ? <span className="spin" /> : '⬇️ Install Daybook'}
          </button>
        ) : isIOS() ? (
          <div style={{ fontSize: 13.5, color: 'var(--ink)', background: 'var(--brand-l)', borderRadius: 12, padding: '12px 14px', marginTop: 8, textAlign: 'left' }}>
            To install on iPhone: tap the <strong>Share</strong> icon in Safari, then <strong>“Add to Home Screen”</strong>.
          </div>
        ) : (
          <div style={{ fontSize: 13.5, color: 'var(--ink)', background: 'var(--brand-l)', borderRadius: 12, padding: '12px 14px', marginTop: 8, textAlign: 'left' }}>
            To install: open this page in <strong>Chrome</strong>, tap the <strong>⋮</strong> menu, then <strong>“Install app”</strong> / “Add to Home screen”.
          </div>
        )}

        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10 }} onClick={onContinue}>
          Continue in browser
        </button>
      </div>
    </div>
  );
}
