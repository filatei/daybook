import React from 'react';
import { useStore, useRole, useActiveTenant, atLeast } from '../store.jsx';

export default function Nav() {
  const { go, tab, tenants, tenant, setTenant, logout, user } = useStore();
  const role = useRole();
  const active = useActiveTenant();
  const isGMup = role && atLeast(role, 'GENERAL_MANAGER');
  const isSuperAdmin = user?.is_superadmin && !tenant;
  // In-app POS: tenant has no external POS source
  const internalPos = active && !active.pos;

  const brand = active?.brand_color || '#0ea5e9';

  return (
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
        <button className="nav-logout" onClick={logout} title="Sign out">⏻</button>
      </div>
      <nav className="nav-tabs">
        <button
          className={tab === 'dashboard' ? 'active' : ''}
          onClick={() => go('dashboard')}
        ><span className="ic">📊</span>Dashboard</button>

        {internalPos && (
          <button
            className={tab === 'sell' ? 'active' : ''}
            onClick={() => go('sell')}
          ><span className="ic">💳</span>Sell</button>
        )}

        <button
          className={tab === 'reports' ? 'active' : ''}
          onClick={() => go('reports')}
        ><span className="ic">🧾</span>Reports</button>

        <button
          className={tab === 'staff' ? 'active' : ''}
          onClick={() => go('staff')}
        ><span className="ic">👷</span>Staff</button>

        <button
          className={tab === 'expenses' ? 'active' : ''}
          onClick={() => go('expenses')}
        ><span className="ic">💸</span>Expenses</button>

        <button
          className={tab === 'documents' ? 'active' : ''}
          onClick={() => go('documents')}
        ><span className="ic">📁</span>Docs</button>

        {isGMup && (
          <button
            className={tab === 'admin' ? 'active' : ''}
            onClick={() => go('admin')}
          ><span className="ic">⚙️</span>Admin</button>
        )}
      </nav>
    </header>
  );
}
