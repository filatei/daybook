import React, { useEffect, useState, useCallback } from 'react';
import { StoreProvider, useStore, useRole, isGateRole } from './store.jsx';
import { api, scoped, setToken } from './api.js';
import Nav from './components/Nav.jsx';
import Modal from './components/Modal.jsx';
import Toast from './components/Toast.jsx';

// Views (lazy-ish — just plain imports for now; split later if bundle grows)
import Dashboard from './views/Dashboard.jsx';
import Reports from './views/Reports.jsx';
import Staff from './views/Staff.jsx';
import Expenses from './views/Expenses.jsx';
import Documents from './views/Documents.jsx';
import Admin from './views/Admin.jsx';
import Sell from './views/Sell.jsx';
import Gate from './views/Gate.jsx';
import Reconcile from './views/Reconcile.jsx';
import More from './views/More.jsx';
import Payroll from './views/Payroll.jsx';
import Generators from './views/Generators.jsx';
import Terminals from './views/Terminals.jsx';
import Products from './views/Products.jsx';
import SiteMessages from './views/SiteMessages.jsx';
import Badges from './views/Badges.jsx';
import Activity from './views/Activity.jsx';

function Inner() {
  const { user, tab, go, login, logout, toast, setTenant, setSites, tenant, tenants } = useStore();
  const role = useRole();
  const [booting, setBooting] = useState(true);

  // Gate-only roles (Gateman, Supervisor) are confined to the Gate screen.
  useEffect(() => { if (isGateRole(role) && tab !== 'gate') go('gate'); }, [role, tab, go]);

  // Sign out cleanly when the session expires (api.js fires this on a 401).
  useEffect(() => {
    const onExpired = () => { localStorage.removeItem('daybook_token'); logout(); toast('Session expired — please sign in again', 'info'); };
    window.addEventListener('daybook-session-expired', onExpired);
    return () => window.removeEventListener('daybook-session-expired', onExpired);
  }, [logout, toast]);

  // ── restore session from localStorage ───────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('daybook_token');
    if (!saved) { setBooting(false); return; }
    setToken(saved);
    api('/auth/me')
      .then((me) => {
        login(me.user, saved, me.tenants);
        setBooting(false);
      })
      .catch(() => {
        localStorage.removeItem('daybook_token');
        setBooting(false);
      });
  }, []);

  // ── load sites whenever tenant changes ───────────────────────────────────────
  useEffect(() => {
    if (!tenant) return;
    api(scoped('/sites')).then((s) => setSites(s)).catch(() => {});
  }, [tenant, setSites]);

  // ── Google identity callback ─────────────────────────────────────────────────
  useEffect(() => {
    window.__daybookGoogleCb = async (resp) => {
      try {
        const data = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } });
        localStorage.setItem('daybook_token', data.token);
        login(data.user, data.token, data.tenants);
        toast('Welcome back!', 'ok');
      } catch (e) {
        toast(e.message || 'Sign-in failed', 'err');
      }
    };
  }, []);

  // ── dev login (non-production) ───────────────────────────────────────────────
  const devLogin = useCallback(async () => {
    try {
      const data = await api('/auth/dev-login', { method: 'POST', body: {} });
      localStorage.setItem('daybook_token', data.token);
      login(data.user, data.token, data.tenants);
    } catch (e) { toast(e.message, 'err'); }
  }, []);

  if (booting) return <div className="boot-screen">Loading…</div>;

  if (!user) return <LoginScreen devLogin={devLogin} />;
  if (!tenants.length) return <OnboardingScreen />;

  return (
    <>
      <Nav />
      <main className="main-content">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'reports'   && <Reports />}
        {tab === 'staff'     && <Staff />}
        {tab === 'expenses'  && <Expenses />}
        {tab === 'documents' && <Documents />}
        {tab === 'admin'     && <Admin />}
        {tab === 'sell'      && <Sell />}
        {tab === 'gate'      && <Gate />}
        {tab === 'reconcile' && <Reconcile />}
        {tab === 'more'       && <More />}
        {tab === 'payroll'    && <Payroll />}
        {tab === 'generators' && <Generators />}
        {tab === 'terminals'  && <Terminals />}
        {tab === 'products'   && <Products />}
        {tab === 'messages'   && <SiteMessages />}
        {tab === 'badges'     && <Badges />}
        {tab === 'activity'   && <Activity />}
      </main>
      <Modal />
      <Toast />
    </>
  );
}

function LoginScreen({ devLogin }) {
  useEffect(() => {
    const initGsi = (gid) => {
      if (!window.google?.accounts?.id || !gid) return;
      window.google.accounts.id.initialize({
        client_id: gid,
        callback: (r) => window.__daybookGoogleCb?.(r),
      });
      window.google.accounts.id.renderButton(
        document.getElementById('gsi-button'),
        { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 },
      );
    };

    // Try cached value first, then fetch from /api/config
    const cached = window.__GOOGLE_CLIENT_ID__;
    if (cached) { initGsi(cached); return; }
    fetch('/api/config').then((r) => r.json()).then((cfg) => {
      if (cfg.google_client_id) {
        window.__GOOGLE_CLIENT_ID__ = cfg.google_client_id;
        // GSI script may still be loading — wait for it
        const tryInit = () => {
          if (window.google?.accounts?.id) initGsi(cfg.google_client_id);
          else setTimeout(tryInit, 200);
        };
        tryInit();
      }
    }).catch(() => {});
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">📒</div>
        <h1 className="login-title">Daybook</h1>
        <p className="login-sub">Daily sales &amp; operations reporting</p>
        <div id="gsi-button" style={{ minHeight: 44 }} />
        {import.meta.env.DEV && (
          <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={devLogin}>
            Dev login
          </button>
        )}
      </div>
    </div>
  );
}

function OnboardingScreen() {
  const { logout } = useStore();
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">📒</div>
        <h2>No workspace yet</h2>
        <p className="login-sub">Ask your administrator to invite you, or contact support.</p>
        <button className="btn btn-ghost" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Inner />
    </StoreProvider>
  );
}
