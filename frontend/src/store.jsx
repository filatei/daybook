import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { setToken, setActiveTenant, api } from './api.js';

const Ctx = createContext(null);

const initial = {
  user: null,
  token: null,
  tenants: [],          // all workspaces the user belongs to
  tenant: null,         // active tenant id
  sites: [],
  tab: 'dashboard',
  toast: null,          // { msg, kind }
  modal: null,          // React node or null
  confirmDlg: null,     // { title, message, confirmText, cancelText, danger } or null
  online: navigator.onLine,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_USER':    return { ...state, user: action.user, token: action.token, tenants: action.tenants };
    case 'SET_TENANT':  return { ...state, tenant: action.id };
    case 'SET_SITES':   return { ...state, sites: action.sites };
    case 'SET_TAB':     return { ...state, tab: action.tab };
    case 'TOAST':       return { ...state, toast: action.toast };
    case 'MODAL':       return { ...state, modal: action.modal };
    case 'CONFIRM':     return { ...state, confirmDlg: action.confirm };
    case 'ONLINE':      return { ...state, online: action.online };
    case 'LOGOUT':      return { ...initial, online: state.online };
    default:            return state;
  }
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);

  const login = useCallback((user, token, tenants) => {
    setToken(token);
    const saved = localStorage.getItem('daybook_tenant');
    const tid = tenants.find((t) => t.id === saved)?.id || tenants[0]?.id || null;
    setActiveTenant(tid);
    dispatch({ type: 'SET_USER', user, token, tenants });
    dispatch({ type: 'SET_TENANT', id: tid });
  }, []);

  const setTenant = useCallback((id) => {
    localStorage.setItem('daybook_tenant', id || '');
    setActiveTenant(id);
    dispatch({ type: 'SET_TENANT', id });
  }, []);

  // ── In-app navigation history (so the phone Back button never closes the app) ──
  // We keep our own stack of visited tabs and a single spare history entry as a
  // buffer. Every hardware/gesture Back triggers popstate (because the buffer is
  // always present), which we handle by closing an open modal or stepping back to
  // the previous screen — falling back to the dashboard — then re-arming the buffer.
  const tabRef = useRef('dashboard');
  const histRef = useRef(['dashboard']);
  const modalRef = useRef(null);
  const guardRef = useRef(false);   // current modal asks "discard changes?" on Back
  const dirtyRef = useRef(false);   // …only when the form was actually edited
  const backRef = useRef([]);       // stack of in-view "go up one level" handlers
  const backId = useRef(0);
  const confirmingRef = useRef(false);   // a discard confirm dialog is open

  // A drill-down view registers a handler for each open sub-level (site list →
  // order list → order). Back invokes the topmost so it steps UP one level
  // instead of jumping to another tab or — worst of all — exiting the app.
  const registerBack = useCallback((fn) => {
    const id = ++backId.current;
    backRef.current.push({ id, fn });
    return () => { backRef.current = backRef.current.filter((b) => b.id !== id); };
  }, []);

  const go = useCallback((tab) => {
    if (tabRef.current !== tab) { histRef.current.push(tab); tabRef.current = tab; }
    dispatch({ type: 'SET_TAB', tab });
  }, []);

  const toast = useCallback((msg, kind = 'info', ms = 3200) => {
    dispatch({ type: 'TOAST', toast: { msg, kind } });
    setTimeout(() => dispatch({ type: 'TOAST', toast: null }), ms);
  }, []);

  // openModal(node, { guard }) — guard prompts to discard unsaved edits on Back.
  const openModal = useCallback((node, opts = {}) => { modalRef.current = node; guardRef.current = !!opts.guard; dirtyRef.current = false; dispatch({ type: 'MODAL', modal: node }); }, []);
  const closeModal = useCallback(() => { modalRef.current = null; guardRef.current = false; dirtyRef.current = false; dispatch({ type: 'MODAL', modal: null }); }, []);
  const setDirty = useCallback((v = true) => { dirtyRef.current = !!v; }, []);

  // confirm(opts) → Promise<boolean> — a styled in-app replacement for window.confirm.
  const confirmResolve = useRef(null);
  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    confirmResolve.current = resolve;
    dispatch({ type: 'CONFIRM', confirm: { confirmText: 'Confirm', cancelText: 'Cancel', ...opts } });
  }), []);
  const resolveConfirm = useCallback((v) => {
    dispatch({ type: 'CONFIRM', confirm: null });
    const r = confirmResolve.current; confirmResolve.current = null;
    if (r) r(v);
  }, []);
  const confirmRef = useRef(confirm); confirmRef.current = confirm;

  useEffect(() => {
    const buffer = () => { try { window.history.pushState({ db: true }, ''); } catch { /* ignore */ } };
    // Keep TWO spare entries so even if a re-arm push is throttled/dropped by the
    // browser, there is still an entry between us and the document — Back can
    // never pop past the app and exit it.
    buffer(); buffer();
    const onPop = async () => {
      if (modalRef.current) {                       // 1) Back closes an open modal first
        if (guardRef.current && dirtyRef.current) {
          if (confirmingRef.current) { buffer(); return; }   // a discard prompt is already open
          buffer();                                          // re-arm before awaiting the dialog
          confirmingRef.current = true;
          const ok = await confirmRef.current({ title: 'Discard changes?', message: 'Your unsaved changes will be lost.', confirmText: 'Discard', cancelText: 'Keep editing', danger: true });
          confirmingRef.current = false;
          if (!ok) return;                                   // keep editing — modal stays
          modalRef.current = null; guardRef.current = false; dirtyRef.current = false; dispatch({ type: 'MODAL', modal: null });
          return;
        }
        modalRef.current = null; guardRef.current = false; dirtyRef.current = false; dispatch({ type: 'MODAL', modal: null });
      } else if (backRef.current.length) {          // 2) …then steps UP one in-view drill level
        const top = backRef.current[backRef.current.length - 1];
        try { top.fn(); } catch { /* ignore */ }
        // the view's effect cleanup unregisters as its sub-level state clears
      } else {                                       // 3) …then steps back a screen (or dashboard)
        const h = histRef.current;
        if (h.length > 1) h.pop();
        const prev = h[h.length - 1] || 'dashboard';
        tabRef.current = prev; dispatch({ type: 'SET_TAB', tab: prev });
      }
      buffer();   // always re-arm so the app is never exited by Back
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const logout = useCallback(() => {
    // Clear the httpOnly session cookie server-side too — otherwise a long-lived
    // cookie would silently re-authenticate on the next reload.
    api('/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('daybook_token');
    localStorage.removeItem('daybook_tenant');
    setToken(null);
    setActiveTenant(null);
    histRef.current = ['dashboard']; tabRef.current = 'dashboard'; modalRef.current = null;
    dispatch({ type: 'LOGOUT' });
  }, []);

  const setSites = useCallback((sites) => dispatch({ type: 'SET_SITES', sites }), []);
  const value = { ...state, login, setTenant, setSites, go, toast, openModal, closeModal, setDirty, confirm, resolveConfirm, registerBack, logout };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);

// Register an in-view "go up one level" handler that the hardware/gesture Back
// button will invoke while `active` is true (e.g. an open drill-down or detail).
// Back then steps up one level instead of changing tab or exiting the app.
export function useBackHandler(active, handler) {
  const { registerBack } = useStore();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active || !registerBack) return undefined;
    return registerBack(() => { if (ref.current) ref.current(); });
  }, [active, registerBack]);
}

// Role helpers — privilege ladder (low → high). Mirrors backend ROLE_RANK.
// Snr Accountant ranks EQUAL to General Manager (same access level).
export const ROLES = [
  'GATEMAN', 'GATE', 'SUPERVISOR',
  'SECRETARY', 'SITE_MANAGER',
  'ACCOUNTANT', 'SNR_ACCOUNTANT',
  'GENERAL_MANAGER', 'ADMIN', 'SUPERADMIN',
];
const RANK = {
  GATEMAN: 1, GATE: 1, SUPERVISOR: 2,
  SECRETARY: 3, SITE_MANAGER: 4,
  ACCOUNTANT: 5,
  SNR_ACCOUNTANT: 7, GENERAL_MANAGER: 7,
  ADMIN: 8, SUPERADMIN: 9,
};
export const atLeast = (role, min) => (RANK[role] || 0) >= (RANK[min] || 0);
// Gate-only roles are locked to the Gate & Loading screen.
export const GATE_ROLES = ['GATEMAN', 'SUPERVISOR', 'GATE'];
export const isGateRole = (role) => GATE_ROLES.includes(role);
// Loading/exit capabilities: Supervisor loads, Gateman exits, Managers+ do both.
export const canLoad = (role) => role === 'SUPERVISOR' || atLeast(role, 'SECRETARY');
export const canExit = (role) => role === 'GATEMAN' || role === 'GATE' || atLeast(role, 'SECRETARY');
export const ROLE_LABELS = {
  GATEMAN: 'Gateman / Security', SUPERVISOR: 'Supervisor (loading)', GATE: 'Gate',
  SECRETARY: 'Secretary', ACCOUNTANT: 'Accountant', SNR_ACCOUNTANT: 'Snr Accountant',
  SITE_MANAGER: 'Manager', GENERAL_MANAGER: 'General Manager', ADMIN: 'Admin',
};

export function useRole() {
  const { user, tenant, tenants } = useStore();
  if (!user) return null;
  if (user.is_superadmin && !tenant) return 'SUPERADMIN';
  const m = tenants.find((t) => t.id === tenant);
  return m?.role || null;
}

export function useActiveTenant() {
  const { tenant, tenants } = useStore();
  return tenants.find((t) => t.id === tenant) || null;
}
