import React, { useEffect, useState, useCallback, useRef } from 'react';
import { StoreProvider, useStore, useRole, isGateRole } from './store.jsx';
import { api, scoped, setToken } from './api.js';
import Nav from './components/Nav.jsx';
import ContactForm from './views/ContactForm.jsx';
import Modal from './components/Modal.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import Toast from './components/Toast.jsx';
import InstallLanding, { isStandalone } from './components/InstallLanding.jsx';
import './chatOutbox.js';   // registers offline-message auto-flush on app boot

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
import Diesel from './views/Diesel.jsx';
import Consolidated from './views/Consolidated.jsx';
import Terminals from './views/Terminals.jsx';
import Products from './views/Products.jsx';
import SiteMessages from './views/SiteMessages.jsx';
import Badges from './views/Badges.jsx';
import Inventory from './views/Inventory.jsx';
import Profit from './views/Profit.jsx';
import Activity from './views/Activity.jsx';
import Chat from './views/Chat.jsx';
import Compliance from './views/Compliance.jsx';

function Inner() {
  const { user, tab, go, login, logout, toast, setSites, tenant, tenants, isGroup, openModal, closeModal } = useStore();
  const role = useRole();
  const [booting, setBooting] = useState(true);
  // A receipt QR was scanned (…/?r=NNNN) in a phone browser without the app:
  // show the install landing first. When dismissed, the receipt is stashed so a
  // signed-in gate user lands straight on the lookup.
  const [scannedReceipt, setScannedReceipt] = useState(() => {
    try {
      const r = new URLSearchParams(window.location.search).get('r');
      if (r) {
        sessionStorage.setItem('daybook_pending_receipt', r.replace(/\D/g, '') || r);
        // strip ?r= from the URL so reloads/installs don't re-trigger the landing
        window.history.replaceState({}, '', window.location.pathname);
        return (!isStandalone()) ? r.replace(/\D/g, '') || r : null;
      }
    } catch { /* ignore */ }
    return null;
  });

  // Gate-only roles (Gateman, Supervisor) are confined to the Gate screen.
  useEffect(() => { if (isGateRole(role) && tab !== 'gate') go('gate'); }, [role, tab, go]);

  // .main-content is the app shell's only scroll area, so it persists across tab
  // changes — reset it to the top whenever the tab switches.
  const mainRef = useRef(null);
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [tab]);

  // ── Pull-to-refresh ───────────────────────────────────────────────────────
  // The fixed app-shell makes .main-content (not the document) the scroller, so
  // the browser's native pull-to-refresh no longer fires. Re-implement it: drag
  // down from the top past the threshold to reload the app (newest bundle).
  const [ptr, setPtr] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let startY = 0, pulling = false, dist = 0;
    const THRESH = 70, MAX = 110;
    const onStart = (e) => {
      if (el.scrollTop <= 0 && e.touches.length === 1) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
      else pulling = false;
    };
    const onMove = (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) { dist = 0; setPtr(0); return; }
      dist = Math.min(MAX, dy * 0.5);   // rubber-band resistance
      setPtr(dist);
    };
    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      if (dist >= THRESH) { setRefreshing(true); setPtr(THRESH); setTimeout(() => window.location.reload(), 250); }
      else setPtr(0);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [user, tenants.length]);

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

  // Customer scanned a receipt QR in a browser without the app → prompt install.
  if (scannedReceipt) return <InstallLanding receipt={scannedReceipt} onContinue={() => setScannedReceipt(null)} />;

  if (booting) return <div className="boot-screen">Loading…</div>;

  if (!user) return <LoginScreen devLogin={devLogin} />;
  if (!tenants.length) return <OnboardingScreen />;

  return (
    <>
      <Nav />
      <main className="main-content" ref={mainRef}>
        <div className="ptr" style={{ height: ptr, opacity: ptr ? 1 : 0 }}>
          <span className={`ptr-ic ${refreshing || ptr >= 70 ? 'go' : ''}`}>↻</span>
        </div>
        {isGroup && tab !== 'dashboard' ? (
          <div className="empty">
            <div className="ic">🏢</div>
            <p>This section works inside a single workspace. You’re viewing the Group roll-up — switch to Fido or Fiafia (top-left) to use it.</p>
            <button className="btn" style={{ width: 'auto', marginTop: 12 }} onClick={() => go('dashboard')}>Back to Group dashboard</button>
          </div>
        ) : (
        <>
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
        {tab === 'diesel'     && <Diesel />}
        {tab === 'consolidated' && <Consolidated />}
        {tab === 'terminals'  && <Terminals />}
        {tab === 'products'   && <Products />}
        {tab === 'messages'   && <SiteMessages />}
        {tab === 'badges'     && <Badges />}
        {tab === 'inventory'  && <Inventory />}
        {tab === 'profit'     && <Profit />}
        {tab === 'activity'   && <Activity />}
        {tab === 'chat'       && <Chat />}
        {tab === 'compliance' && <Compliance />}
        </>
        )}
        <footer className="app-footer">
          © {new Date().getFullYear()} Torama Technologies ·{' '}
          <a role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openModal(<ContactForm onClose={closeModal} />)}>Contact us</a> ·{' '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a> ·{' '}
          <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms</a>
        </footer>
      </main>
      <Modal />
      <ConfirmDialog />
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
      <div className="login-copyright">© {new Date().getFullYear()} Torama Technologies</div>
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
