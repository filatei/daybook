import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore, useRole, useActiveTenant, atLeast, isGateRole } from '../store.jsx';
import { api, scoped } from '../api.js';
import { useRealtime } from '../hooks/useRealtime.js';
import AIAssistant from './AIAssistant.jsx';

// Live total of unread direct messages → the Nav chat badge.
function useChatUnread(meId) {
  const [total, setTotal] = useState(0);
  const load = useCallback(() => { api(scoped('/chat/unread')).then((r) => setTotal(r.total || 0)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useRealtime((evt) => {
    if (evt.type === 'chat.message' && evt.payload?.to_user === meId) load();
    else if (evt.type === 'chat.read') load();
  });
  useEffect(() => { const h = () => load(); window.addEventListener('chat-read', h); return () => window.removeEventListener('chat-read', h); }, [load]);
  return total;
}

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

// ── Profile avatar + dropdown (replaces the old sign-out icon) ─────────────────
function ProfileMenu({ user, isGMup, isMgr, go, logout, canInstall, install }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const initial = (user?.name || user?.email || '?').trim()[0]?.toUpperCase() || '?';
  const item = (label, icon, fn) => (
    <button className="pm-item" onClick={() => { setOpen(false); fn(); }}>
      <span style={{ width: 20 }}>{icon}</span>{label}
    </button>
  );
  return (
    <div className="profile-wrap" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen((o) => !o)} title="Account">
        {user?.photo_url ? <img src={user.photo_url} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} /> : initial}
      </button>
      {open && (
        <div className="pm pop-in">
          <div className="pm-head">
            <div style={{ fontWeight: 800 }}>{user?.name || 'Signed in'}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.email}</div>
          </div>
          {item('Activity & messages', '🔔', () => go('activity'))}
          {isGMup && item('Admin', '⚙️', () => go('admin'))}
          {!isGMup && isMgr && item('Members', '👥', () => go('admin'))}
          {item('Test plan', '✅', () => { setOpen(false); window.open('/testplan.html', '_blank'); })}
          {canInstall && item('Install app', '⬇', install)}
          <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          {item('Sign out', '⏻', logout)}
        </div>
      )}
    </div>
  );
}

export default function Nav() {
  const { go, tab, tenants, tenant, setTenant, logout, user, openModal, closeModal } = useStore();
  const role    = useRole();
  const active  = useActiveTenant();
  const { canInstall, install } = useInstallPrompt();
  const unread = useChatUnread(user?.id);

  const isGMup       = role && atLeast(role, 'GENERAL_MANAGER');
  const isMgr        = role && atLeast(role, 'SITE_MANAGER');
  const isAdmin      = role && atLeast(role, 'ADMIN');
  const isSuperAdmin = user?.is_superadmin && !tenant;
  const isGate       = isGateRole(role);
  const showSell = !!active;

  const brand = active?.brand_color || '#0ea5e9';

  // Gate/security users get a single, focused destination — nothing else.
  const tabs = isGate
    ? [{ id: 'gate', icon: '🚧', label: 'Gate & Loading', show: true }]
    : [
      { id: 'dashboard', icon: '📊', label: 'Dashboard', show: true },
      { id: 'sell',      icon: '💳', label: 'Sales',     show: showSell },
      { id: 'expenses',  icon: '💸', label: 'Expenses',  show: true },
      { id: 'reports',   icon: '🧾', label: 'Reports',   show: true },
      { id: 'more',      icon: '⋯',  label: 'More',      show: true },
    ].filter((t) => t.show);

  // "More" is the active highlight for any destination that lives inside it.
  const MORE_TABS = ['more', 'gate', 'payroll', 'generators', 'compliance'];
  const isActive = (id) => id === 'more' ? MORE_TABS.includes(tab) : tab === id;

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
          {isAdmin && (
            <button className="chat-btn ai-hdr-btn" onClick={() => openModal(<AIAssistant onClose={closeModal} />, { guard: true })} title="Ask Daybook AI" aria-label="AI assistant">
              🤖
            </button>
          )}
          <button className="chat-btn" onClick={() => go('chat')} title="Chat" aria-label="Chat"
            style={{ position: 'relative' }}>
            💬
            {unread > 0 && <span className="chat-badge nav">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <ProfileMenu user={user} isGMup={isGMup} isMgr={isMgr} go={go} logout={logout} canInstall={canInstall} install={install} />
        </div>

        {/* Desktop tab strip (hidden on mobile via CSS) */}
        <nav className="nav-tabs">
          {tabs.map(({ id, icon, label }) => (
            <button key={id} className={isActive(id) ? 'active' : ''} onClick={() => go(id)}>
              <span className="ic">{icon}</span>{label}
            </button>
          ))}
        </nav>
      </header>

      {/* AI assistant — floating FAB on mobile (bottom-left), Admin only */}
      {isAdmin && (
        <button className="ai-fab" onClick={() => openModal(<AIAssistant onClose={closeModal} />, { guard: true })} title="Ask Daybook AI" aria-label="AI assistant">
          🤖
        </button>
      )}

      {/* ── Bottom nav (mobile only, fixed at bottom) ─────────── */}
      <nav className="bottom-nav">
        {tabs.map(({ id, icon, label }) => (
          <button key={id} className={isActive(id) ? 'active' : ''} onClick={() => go(id)}>
            <span className="ic">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
