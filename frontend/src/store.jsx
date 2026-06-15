import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { setToken, setActiveTenant } from './api.js';

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

  const go = useCallback((tab) => dispatch({ type: 'SET_TAB', tab }), []);

  const toast = useCallback((msg, kind = 'info', ms = 3200) => {
    dispatch({ type: 'TOAST', toast: { msg, kind } });
    setTimeout(() => dispatch({ type: 'TOAST', toast: null }), ms);
  }, []);

  const openModal = useCallback((node) => dispatch({ type: 'MODAL', modal: node }), []);
  const closeModal = useCallback(() => dispatch({ type: 'MODAL', modal: null }), []);

  const logout = useCallback(() => {
    localStorage.removeItem('daybook_token');
    localStorage.removeItem('daybook_tenant');
    setToken(null);
    setActiveTenant(null);
    dispatch({ type: 'LOGOUT' });
  }, []);

  const setSites = useCallback((sites) => dispatch({ type: 'SET_SITES', sites }), []);
  const value = { ...state, login, setTenant, setSites, go, toast, openModal, closeModal, logout };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);

// Role helpers — privilege ladder (low → high)
export const ROLES = [
  'GATEMAN', 'GATE', 'SUPERVISOR',
  'SECRETARY', 'ACCOUNTANT', 'SNR_ACCOUNTANT',
  'SITE_MANAGER', 'GENERAL_MANAGER', 'ADMIN', 'SUPERADMIN',
];
export const atLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);
// Gate-only roles are locked to the Gate & Loading screen.
export const GATE_ROLES = ['GATEMAN', 'SUPERVISOR', 'GATE'];
export const isGateRole = (role) => GATE_ROLES.includes(role);
// Loading/exit capabilities: Supervisor loads, Gateman exits, Managers+ do both.
export const canLoad = (role) => role === 'SUPERVISOR' || atLeast(role, 'SITE_MANAGER');
export const canExit = (role) => role === 'GATEMAN' || role === 'GATE' || atLeast(role, 'SITE_MANAGER');
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
