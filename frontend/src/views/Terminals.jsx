/**
 * Terminals.jsx — manage POS terminals (which bank, which location).
 * CRUD allowed for Manager, GM, Accountant, Snr Accountant, Admin (SITE_MANAGER+).
 * These terminals power the "which POS?" picker on the Sell screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

function TerminalForm({ row, sites, siteBound, onSaved, onClose }) {
  const { toast } = useStore();
  const editing = !!row;
  const [f, setF] = useState({
    bank: row?.bank || '', location: row?.location || '', terminal_id: row?.terminal_id || '',
    sn: row?.sn || '', site_id: row?.site_id || (sites[0]?.id || ''),
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!f.bank.trim()) { toast('Enter the bank', 'err'); return; }
    setSaving(true);
    try {
      const body = { bank: f.bank.trim(), location: f.location.trim(), terminal_id: f.terminal_id.trim(), sn: f.sn.trim(), site_id: f.site_id || null };
      if (editing) await api(scoped(`/pos/terminals/${row.id}`), { method: 'PATCH', body });
      else await api(scoped('/pos/terminals'), { method: 'POST', body });
      toast(editing ? 'Terminal updated ✓' : 'Terminal added ✓', 'ok');
      onSaved(); onClose();
    } catch (e) { toast(e.message || 'Could not save', 'err'); }
    setSaving(false);
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 400, margin: 0, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 12 }}>{editing ? 'Edit terminal' : 'New POS terminal'}</div>

        <label className="fl">Bank</label>
        <input className="input" value={f.bank} onChange={set('bank')} placeholder="e.g. Moniepoint, GTB, Access" style={{ marginBottom: 10 }} />

        <label className="fl">Location / label (optional)</label>
        <input className="input" value={f.location} onChange={set('location')} placeholder="e.g. Front desk, Gate 2" style={{ marginBottom: 10 }} />

        {!siteBound && sites.length > 0 && (
          <>
            <label className="fl">Site (optional)</label>
            <select className="input" value={f.site_id} onChange={set('site_id')} style={{ marginBottom: 10 }}>
              <option value="">All sites</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label className="fl">Terminal ID (optional)</label>
            <input className="input" value={f.terminal_id} onChange={set('terminal_id')} placeholder="TID" />
          </div>
          <div style={{ flex: 1 }}>
            <label className="fl">Serial no. (optional)</label>
            <input className="input" value={f.sn} onChange={set('sn')} placeholder="SN" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : (editing ? 'Save' : 'Add terminal')}</button>
        </div>
      </div>
    </div>
  );
}

export default function Terminals() {
  const { tenant, sites, toast } = useStore();
  const role = useRole();
  const canManage = role && atLeast(role, 'SITE_MANAGER');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(null);   // { row } for edit, {} for new
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(async () => {
    try { setRows(await api(scoped('/pos/terminals/manage'))); } catch { setRows([]); }
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const remove = async () => {
    try { await api(scoped(`/pos/terminals/${confirmDel.id}`), { method: 'DELETE' }); toast('Terminal removed', 'ok'); setConfirmDel(null); load(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };

  if (!canManage) return <div className="empty"><div className="ic">🔒</div><p>You don't have access to manage terminals</p></div>;

  const active = (rows || []).filter((r) => (r.status || 'ACTIVE') !== 'INACTIVE');
  const inactive = (rows || []).filter((r) => (r.status || 'ACTIVE') === 'INACTIVE');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="section-title" style={{ margin: 0 }}>POS Terminals</div>
        <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => setForm({})}>＋ New</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0, marginBottom: 14 }}>
        These appear in the "which POS?" picker when a sale is paid by card.
      </p>

      {rows === null ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : active.length === 0 ? (
        <div className="empty"><div className="ic">💳</div><p>No terminals yet — add your first one</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {active.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
              <div className="av" style={{ background: '#eff6ff', color: '#1e40af', borderRadius: 8 }}>💳</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.bank}{r.location ? ` · ${r.location}` : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {r.site_name || 'All sites'}{r.terminal_id ? ` · TID ${r.terminal_id}` : ''}{r.sn ? ` · SN ${r.sn}` : ''}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => setForm({ row: r })}>Edit</button>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px', color: 'var(--err)' }} onClick={() => setConfirmDel(r)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {inactive.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>{inactive.length} removed terminal{inactive.length > 1 ? 's' : ''} (kept for history)</div>
      )}

      {form && <TerminalForm row={form.row} sites={sites} siteBound={siteBound} onSaved={load} onClose={() => setForm(null)} />}

      {confirmDel && (
        <div onClick={() => setConfirmDel(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 320, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 30, marginBottom: 4 }}>💳</div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Remove this terminal?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 16px' }}>{confirmDel.bank}{confirmDel.location ? ` · ${confirmDel.location}` : ''}. Past sales keep their record.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: 'var(--err)' }} onClick={remove}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
