import React, { useEffect, useState } from 'react';

// True when the app is already running as an installed PWA (standalone), so we
// never show the install prompt to someone who already has the app.
export const isStandalone = () =>
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');

/** Compact banner (same shell as PushPrompt) — shown after a push click opens the
 *  browser instead of the installed PWA, or when ?install=1 is present.
 *  Browsers cannot force-install from a notification click; this is best-effort. */
export function InstallBanner({ onDismiss }) {
  const [canInstall, setCanInstall] = useState(() => !!window.__pwaInstallPrompt);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const on = () => setCanInstall(true);
    const done = () => { try { sessionStorage.removeItem('daybook_prompt_install'); } catch { /* ignore */ } onDismiss?.(); };
    window.addEventListener('pwa-installable', on);
    window.addEventListener('pwa-installed', done);
    return () => { window.removeEventListener('pwa-installable', on); window.removeEventListener('pwa-installed', done); };
  }, [onDismiss]);

  if (isStandalone()) return null;

  const install = async () => {
    const p = window.__pwaInstallPrompt;
    if (!p) return;
    setInstalling(true);
    try { p.prompt(); await p.userChoice; window.__pwaInstallPrompt = null; setCanInstall(false); } catch { /* dismissed */ }
    setInstalling(false);
  };

  const dismiss = () => {
    try { sessionStorage.removeItem('daybook_prompt_install'); } catch { /* ignore */ }
    onDismiss?.();
  };

  return (
    <div className="push-banner">
      <div className="push-banner-ic">⬇</div>
      <div className="push-banner-copy">
        <div className="push-banner-t">Install Daybook</div>
        <div className="push-banner-s">
          {canInstall
            ? 'Add the app for full-screen access and reliable notifications.'
            : isIOS()
              ? 'On iPhone: Share → Add to Home Screen.'
              : 'Open Chrome menu (⋮) → Install app / Add to Home screen. Or use profile menu → Install app when available.'}
        </div>
      </div>
      <div className="push-banner-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Later</button>
        {canInstall && (
          <button type="button" className="btn btn-sm" onClick={install} disabled={installing}>
            {installing ? <span className="spin" /> : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

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
