import React, { useState } from 'react';
import { useStore, useRole, useActiveTenant, atLeast } from '../store.jsx';
import { pushSupported, pushPermission, enablePush } from '../push.js';

function NotificationsMoreCard() {
  const { toast } = useStore();
  const [perm, setPerm] = useState(() => pushPermission());
  if (!pushSupported()) return null;
  const on = perm === 'granted';
  const denied = perm === 'denied';
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 2px 8px' }}>Account</div>
      <div className="more-grid">
        <button className="more-card" onClick={async () => {
          if (on) { toast('Notifications are on for this device', 'ok'); return; }
          if (denied) { toast('Notifications are blocked — enable them in the browser or phone settings', 'err'); return; }
          try { await enablePush(); setPerm('granted'); toast('Notifications enabled', 'ok'); }
          catch (e) { toast(e.message || 'Could not enable notifications', 'err'); }
        }}>
          <div className="more-ic">🔔</div>
          <div>
            <div style={{ fontWeight: 800 }}>Notifications</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {on ? 'On for this device' : (denied ? 'Blocked in browser settings' : 'Alerts for reports, expenses and chat')}
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

/**
 * More — launcher for secondary / operational screens that don't warrant a
 * primary tab.  Role-gated: Payroll is GM+; Generators is Secretary+.
 */
export default function More() {
  const { go } = useStore();
  const role = useRole();
  const active = useActiveTenant();
  const isMgr = role && atLeast(role, 'SITE_MANAGER');          // Manager+
  const isAcct = role && atLeast(role, 'ACCOUNTANT');           // Accountant+
  const isSec = role && atLeast(role, 'SECRETARY');             // Secretary+
  const isSnr = role && atLeast(role, 'SNR_ACCOUNTANT');        // Snr Accountant / GM / Admin

  const items = [
    { id: 'gate',       group: 'Operations', icon: '🚧', label: 'Gate & Loading', desc: 'Scan receipts, mark loaded & released', show: isSec && !!active },
    { id: 'inventory',  group: 'Operations', icon: '📦', label: 'Inventory',  desc: 'Stock items, receive/issue, low-stock',     show: isSec },
    { id: 'generators', group: 'Operations', icon: '🔌', label: 'Generators', desc: 'Assets, diesel fills & maintenance',       show: isSec },
    { id: 'diesel',     group: 'Operations', icon: '⛽', label: 'Diesel',     desc: 'Daily diesel per site — litres, rate & amount', show: isSec },
    { id: 'documents',  group: 'Operations', icon: '📁', label: 'Documents',  desc: 'Incident reports & daily logs',           show: isSec },
    { id: 'messages',   group: 'Operations', icon: '✉️', label: 'Site Messages', desc: role && atLeast(role, 'ADMIN') ? 'Private messages from site users' : 'Send a private note to the admin', show: !!active },

    { id: 'staff',      group: 'People', icon: '👷', label: 'Staff',      desc: 'Clock-in, badge & face, attendance',        show: isSec },
    { id: 'badges',     group: 'People', icon: '🪪', label: 'Staff Badges', desc: 'Design & print scannable ID badges',        show: isSec },
    { id: 'payroll',    group: 'People', icon: '💰', label: 'Payroll',    desc: 'Pay runs, rates & imported history',       show: isAcct },

    { id: 'profit',       group: 'Finance', icon: '📈', label: 'Profit & Loss', desc: 'Revenue − expenses by site & period',      show: isMgr },
    { id: 'eod',          group: 'Finance', icon: '🧾', label: 'End-of-day POS', desc: 'Photograph each terminal’s EOD slip — totals & variance', show: isSec },
    { id: 'reconcile',    group: 'Finance', icon: '🏦', label: 'Reconcile',  desc: 'Match transfers, POS & cash deposits',    show: isAcct },
    { id: 'consolidated', group: 'Finance', icon: '🧾', label: 'Consolidated report', desc: 'All-sites end-of-day total — auto + manual, email', show: isSnr },

    { id: 'products',   group: 'Setup', icon: '🛒', label: 'Products',    desc: 'Catalogue & prices used at the till',       show: isMgr },
    { id: 'terminals',  group: 'Setup', icon: '💳', label: 'POS Terminals', desc: 'Banks & POS machines for card sales',     show: isMgr },
    { id: 'compliance', group: 'Setup', icon: '🏛️', label: 'Compliance', desc: 'Licenses, certificates & permits + expiry alerts', show: isSec },
  ].filter((i) => i.show);

  const GROUPS = ['Operations', 'People', 'Finance', 'Setup'];
  const sections = GROUPS.map((g) => ({ group: g, list: items.filter((i) => i.group === g) })).filter((s) => s.list.length);

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>More</div>
      <NotificationsMoreCard />
      {sections.map((s) => (
        <div key={s.group} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 2px 8px' }}>{s.group}</div>
          <div className="more-grid">
            {s.list.map((i) => (
              <button key={i.id} className="more-card" onClick={() => go(i.id)}>
                <div className="more-ic">{i.icon}</div>
                <div>
                  <div style={{ fontWeight: 800 }}>{i.label}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{i.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
      {items.length === 0 && !pushSupported() && <div className="empty"><div className="ic">⋯</div><p>Nothing here for your role yet</p></div>}
    </div>
  );
}
