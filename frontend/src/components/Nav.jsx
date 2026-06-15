import React, { useState, useEffect } from 'react';
import { useStore, useRole, useActiveTenant, atLeast } from '../store.jsx';

function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(() => !!window.__pwaInstallPrompt);
  useEffect(() => {
    const on  = () => setCanInstall(true);
    const off = () => setCanInstall(false);
    window.addEventListener('pwa-installable', on);
    window.addEventListener('pwa-installed',   off);
    return () => { window.removeEventListener('pwa-installable', on); window.removeEventListener('pwa-installed', off); };
  }, []);
  const install = async () => {
    const prompt = window.__pwaInstallPrompt;
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    window.__pwaInstallPrompt = null;
    setCanInstall(false);
  };
  return { canInstall, install };
}

export default function Nav() {
  const { go, tab, tenants, tenant, setTenant, logout, user } = useStore();
  const role    = useRole();
  const active  = useActiveTenant();
  const { canInstall, install } = useInstallPrompt();

  const isGMup       = role && atLeast(role, 'GENERAL_MANAGER');
  const isSuperAdmin  = user?.is_superadmin && !tenant;
  // Show Sell & Gate for any active tenant context
  const showSell = !!active;
  const showGate = !!active;

  const brand = active?.brand_color || '#0ea5e9';

  const tabs = [
    { id: 'dashboard', icon: '📊', label: 'Dashboard', show: true },
    { id: 'sell',      icon: '💳', label: 'Sell',      show: showSell },
    { id: 'reports',   icon: '🧾', label: 'Reports',   show: true },
    { id: 'staff',     icon: '👷', label: 'Staff',     show: true },
    { id: 'gate',      icon: '🚧', label: 'Gate',      show: showGate },
    { id: 'expenses',  icon: '💸', label: 'Expenses',  show: true },
    { id: 'documents', icon: '📁', label: 'Docs',      show: true },
    { id: 'admin',     icon: '⚙️', label: 'Admin',     show: isGMup },
  ].filter((t) => t.show);

  return (
    <>
      {/* ── Top header (sticky) ───────────────────────────────── */}
      <header className="nav" style={{ '--brand': brand }}>
        <div className="nav-top">
          <span className="nav-logo">📒 Daybook</span>
          <select
            className="tenant-sel"
            value={tenant || ''}
            onChange={(e) => setTenant(e.target.value || null)}
          >
            {isSuperAdmin && <option value="">All workspaces</option>}
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {canInstall && (
            <button
              onClick={install}
              title="Install app"
              style={{ background: 'rgba(255,255,255,.2)', border: '1px solid rgba(255,255,255,.4)', color: '#fff', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >⬇ Install</button>
          )}
          <button className="nav-logout" onClick={logout} title="Sign out">⏻</button>
        </div>

        {/* Desktop tab strip (hidden on mobile via CSS) */}
        <nav className="nav-tabs">
          {tabs.map(({ id, icon, label }) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => go(id)}>
              <span className="ic">{icon}</span>{label}
            </button>
          ))}
        </nav>
      </header>

      {/* ── Bottom nav (mobile only, fixed at bottom) ─────────── */}
      <nav className="bottom-nav">
        {tabs.map(({ id, icon, label }) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => go(id)}>
            <span className="ic">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
