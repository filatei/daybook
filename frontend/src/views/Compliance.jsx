import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const TYPES = ['LICENSE', 'CERTIFICATE', 'PERMIT', 'LETTER', 'OTHER'];
const TYPE_ICON = { LICENSE: '📜', CERTIFICATE: '🎖️', PERMIT: '🪪', LETTER: '✉️', OTHER: '📁' };
const STATUS = {
  EXPIRED: { bg: '#fee2e2', fg: '#991b1b', label: 'Expired' },
  EXPIRING: { bg: '#fef3c7', fg: '#92400e', label: 'Expiring' },
  VALID: { bg: '#dcfce7', fg: '#166534', label: 'Valid' },
  NO_EXPIRY: { bg: '#f1f5f9', fg: '#475569', label: 'No expiry' },
};
const statusText = (d) => d.status === 'EXPIRED' ? 'Expired' : d.status === 'EXPIRING' ? `Expires in ${d.days_to_expiry} day${d.days_to_expiry === 1 ? '' : 's'}` : d.status === 'VALID' ? `Valid · expires ${d.expiry_date}` : 'No expiry date';

function ComplianceForm({ doc, sites, siteBound, onSaved, onClose }) {
  const { toast } = useStore();
  const [f, setF] = useState({
    doc_type: doc?.doc_type || 'LICENSE', title: doc?.title || '', issuer: doc?.issuer || '',
    reference_no: doc?.reference_no || '', issue_date: doc?.issue_date || '', expiry_date: doc?.expiry_date || '',
    site_id: doc?.site_id || '', notes: doc?.notes || '',
  });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!f.title.trim()) return toast('Title is required', 'err');
    setSaving(true);
    try {
      if (doc?.id) {
        await api(scoped(`/compliance/${doc.id}`), { method: 'PATCH', body: f });
      } else {
        const fd = new FormData();
        Object.entries(f).forEach(([k, v]) => { if (v) fd.append(k, v); });
        if (file) fd.append('file', file);
        await api(scoped('/compliance'), { method: 'POST', form: fd });
      }
      toast('Saved ✓', 'ok'); onSaved(); onClose();
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>{doc?.id ? 'Edit document' : 'Add compliance document'}</h3>
      <div className="grid2">
        <div>
          <label className="fl">Type</label>
          <select className="input" value={f.doc_type} onChange={(e) => set('doc_type', e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_ICON[t]} {t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
        </div>
        {!siteBound && sites.length > 0 && (
          <div>
            <label className="fl">Applies to</label>
            <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>
              <option value="">🌍 Whole company</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <label className="fl">Title *</label>
      <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. NAFDAC Product Registration" />
      <div className="grid2">
        <div>
          <label className="fl">Issuer / authority</label>
          <input className="input" value={f.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="NAFDAC, SON, State Govt…" />
        </div>
        <div>
          <label className="fl">Reference / cert no.</label>
          <input className="input" value={f.reference_no} onChange={(e) => set('reference_no', e.target.value)} />
        </div>
        <div>
          <label className="fl">Issue date</label>
          <input type="date" className="input" value={f.issue_date} onChange={(e) => set('issue_date', e.target.value)} />
        </div>
        <div>
          <label className="fl">Expiry date</label>
          <input type="date" className="input" value={f.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} />
        </div>
      </div>
      <label className="fl">Notes</label>
      <textarea className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      {!doc?.id && (
        <>
          <label className="fl">File</label>
          <input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] || null)}
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.bmp,.tif,.tiff,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.ppt,.pptx,.zip,image/*" />
        </>
      )}
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
      </div>
    </div>
  );
}

export default function Compliance() {
  const { tenant, sites, openModal, closeModal, toast, confirm } = useStore();
  const role = useRole();
  const canManage = role && atLeast(role, 'SITE_MANAGER');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');
  const [docs, setDocs] = useState(null);
  const [filter, setFilter] = useState({ type: '', status: '' });

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (filter.type) p.set('type', filter.type);
    if (filter.status) p.set('status', filter.status);
    api(scoped(`/compliance?${p}`)).then((r) => setDocs(Array.isArray(r) ? r : [])).catch(() => setDocs([]));
  }, [tenant, filter]);
  useEffect(() => { load(); }, [load]);

  const openForm = (doc = null) => openModal(<ComplianceForm doc={doc} sites={sites} siteBound={siteBound} onSaved={load} onClose={closeModal} />, { guard: true });

  const download = async (d) => {
    try {
      const res = await fetch(`/api/compliance/${d.id}/download?tenant=${tenant}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = d.file_name || 'document'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) { toast(e.message || 'Could not download', 'err'); }
  };
  const remove = async (d) => {
    if (!await confirm({ title: `Delete “${d.title}”?`, message: 'This permanently removes the document and its file.', confirmText: 'Delete', danger: true })) return;
    try { await api(scoped(`/compliance/${d.id}`), { method: 'DELETE' }); toast('Deleted', 'ok'); load(); }
    catch (e) { toast(e.message || 'Could not delete', 'err'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>🏛️ Compliance</div>
        {canManage && <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => openForm()}>＋ Add</button>}
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>Government & regulator letters, licenses, certificates and permits — with expiry reminders.</p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="input" style={{ flex: '1 1 140px' }} value={filter.type} onChange={(e) => setFilter((p) => ({ ...p, type: e.target.value }))}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_ICON[t]} {t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
        </select>
        <select className="input" style={{ flex: '1 1 140px' }} value={filter.status} onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}>
          <option value="">All statuses</option>
          <option value="EXPIRED">Expired</option>
          <option value="EXPIRING">Expiring soon</option>
          <option value="VALID">Valid</option>
          <option value="NO_EXPIRY">No expiry</option>
        </select>
      </div>

      {docs === null ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
        : docs.length === 0 ? <div className="empty"><div className="ic">🏛️</div><p>No documents yet{canManage ? ' — tap ＋ Add' : ''}</p></div>
          : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {docs.map((d) => {
                const st = STATUS[d.status] || STATUS.NO_EXPIRY;
                return (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                    <div className="av" style={{ fontSize: 20 }}>{TYPE_ICON[d.doc_type] || '📁'}</div>
                    <button onClick={() => d.stored_name && download(d)} style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: d.stored_name ? 'pointer' : 'default', padding: 0 }}>
                      <div style={{ fontWeight: 700 }}>{d.title}{d.stored_name ? ' ↓' : ''}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {[d.issuer, d.reference_no, d.site_name || 'Company-wide'].filter(Boolean).join(' · ')}
                      </div>
                      <div style={{ fontSize: 11.5, marginTop: 3 }}>
                        <span className="badge" style={{ background: st.bg, color: st.fg }}>{statusText(d)}</span>
                      </div>
                    </button>
                    {canManage && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button title="Edit" onClick={() => openForm(d)} style={{ border: 'none', background: '#e0f2fe', color: '#0369a1', borderRadius: 7, width: 30, height: 30, cursor: 'pointer' }}>✎</button>
                        <button title="Delete" onClick={() => remove(d)} style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 7, width: 30, height: 30, cursor: 'pointer' }}>🗑</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
    </div>
  );
}
