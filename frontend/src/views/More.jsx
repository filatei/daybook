import React from 'react';
import { useStore, useRole, useActiveTenant, atLeast } from '../store.jsx';

/**
 * More — launcher for secondary / operational screens that don't warrant a
 * primary tab.  Role-gated: Payroll is GM+; Generators is manager+ (SITE_MANAGER+).
 */
export default function More() {
  const { go } = useStore();
  const role = useRole();
  const active = useActiveTenant();
  const isMgr = role && atLeast(role, 'SITE_MANAGER');          // Manager+
  const isAcct = role && atLeast(role, 'ACCOUNTANT');           // Accountant+
  const isSec = role && atLeast(role, 'SECRETARY');             // Secretary+

  const items = [
    { id: 'messages',   icon: '✉️', label: 'Site Messages', desc: role && atLeast(role, 'ADMIN') ? 'Private messages from site users' : 'Send a private note to the admin', show: !!active },
    { id: 'gate',       icon: '🚧', label: 'Gate & Loading', desc: 'Scan receipts, mark loaded & released', show: isSec && !!active },
    { id: 'documents',  icon: '📁', label: 'Documents',  desc: 'Incident reports & daily logs',           show: isSec },
    { id: 'compliance', icon: '🏛️', label: 'Compliance', desc: 'Licenses, certificates & permits + expiry alerts', show: isSec },
    { id: 'inventory',  icon: '📦', label: 'Inventory',  desc: 'Stock items, receive/issue, low-stock',     show: isSec },
    { id: 'profit',     icon: '📈', label: 'Profit & Loss', desc: 'Revenue − expenses by site & period',      show: isMgr },
    { id: 'reconcile',  icon: '🏦', label: 'Reconcile',  desc: 'Transfers, POS & cash deposits',          show: isAcct },
    { id: 'payroll',    icon: '💰', label: 'Payroll',    desc: 'Pay runs, rates & imported history',       show: isAcct },
    { id: 'staff',      icon: '👷', label: 'Staff',      desc: 'Clock-in, badge & face, attendance',        show: isSec },
    { id: 'badges',     icon: '🪪', label: 'Staff Badges', desc: 'Design & print scannable ID badges',        show: isSec },
    { id: 'generators', icon: '🔌', label: 'Generators', desc: 'Assets, diesel fills & maintenance',       show: isSec },
    { id: 'terminals',  icon: '💳', label: 'POS Terminals', desc: 'Banks & POS machines for card sales',     show: isMgr },
    { id: 'products',   icon: '🛒', label: 'Products',    desc: 'Catalogue & prices used at the till',       show: isMgr },
  ].filter((i) => i.show);

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>More</div>
      <div className="more-grid">
        {items.map((i) => (
          <button key={i.id} className="more-card" onClick={() => go(i.id)}>
            <div className="more-ic">{i.icon}</div>
            <div>
              <div style={{ fontWeight: 800 }}>{i.label}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{i.desc}</div>
            </div>
          </button>
        ))}
      </div>
      {items.length === 0 && <div className="empty"><div className="ic">⋯</div><p>Nothing here for your role yet</p></div>}
    </div>
  );
}
