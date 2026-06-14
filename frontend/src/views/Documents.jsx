import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

const CAT_ICONS = { policy: '📋', invoice: '🧾', contract: '📜', report: '📊', other: '📁' };
const CATS = Object.keys(CAT_ICONS);

function timeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

export default function Documents() {
  const { openModal, closeModal, toast, tenant, sites } = useStore();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState({ cat: '', site: '' });
  const fileRef = useRef(null);
  const [meta, setMeta] = useState({ title: '', category: CATS[0], site_id: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filter.cat) p.set('category', filter.cat);
      if (filter.site) p.set('site', filter.site);
      setDocs(await api(scoped(`/documents?${p}`)));
    } catch { setDocs([]); }
    setLoading(false);
  }, [tenant, filter]);

  useEffect(() => { load(); }, [load]);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', meta.title || file.name);
      fd.append('category', meta.category);
      if (meta.site_id) fd.append('site_id', meta.site_id);
      if (meta.notes) fd.append('notes', meta.notes);
      const token = localStorage.getItem('daybook_token');
      const tid = localStorage.getItem('daybook_tenant');
      const headers = { Authorization: `Bearer ${token}` };
      if (tid) headers['X-Tenant-Id'] = tid;
      const res = await fetch('/api/documents', { method: 'POST', headers, body: fd });
      if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
      toast('Uploaded ✓', 'ok'); closeModal(); load();
    } catch (e) { toast(e.message, 'err'); }
    setUploading(false);
  };

  const openUpload = () => {
    openModal(
      <div>
        <div className="grip" />
        <h3>Upload Document</h3>
        <label className="fl">Title</label>
        <input className="input" placeholder="Optional" value={meta.title} onChange={(e) => setMeta((p) => ({ ...p, title: e.target.value }))} />
        <label className="fl">Category</label>
        <select className="input" value={meta.category} onChange={(e) => setMeta((p) => ({ ...p, category: e.target.value }))}>
          {CATS.map((c) => <option key={c}>{c}</option>)}
        </select>
        {sites.length > 1 && <>
          <label className="fl">Site (optional)</label>
          <select className="input" value={meta.site_id} onChange={(e) => setMeta((p) => ({ ...p, site_id: e.target.value }))}>
            <option value="">Company-wide</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </>}
        <label className="fl">Notes</label>
        <input className="input" value={meta.notes} onChange={(e) => setMeta((p) => ({ ...p, notes: e.target.value }))} />
        <div className="cap-bar">
          <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
          <button className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <span className="spin" /> : null} Choose File
          </button>
        </div>
        <input type="file" ref={fileRef} style={{ display: 'none' }}
          accept=".pdf,.xls,.xlsx,.csv,.doc,.docx,.png,.jpg,.jpeg" onChange={(e) => upload(e.target.files[0])} />
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <select className="input" value={filter.cat}
          onChange={(e) => setFilter((p) => ({ ...p, cat: e.target.value }))}>
          <option value="">All types</option>
          {CATS.map((c) => <option key={c}>{c}</option>)}
        </select>
        {sites.length > 1 && (
          <select className="input" value={filter.site}
            onChange={(e) => setFilter((p) => ({ ...p, site: e.target.value }))}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : docs.length === 0 ? (
        <div className="empty"><div className="ic">📁</div><p>No documents yet</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {docs.map((d) => (
            <a key={d.id} href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', textDecoration: 'none', color: 'inherit', borderBottom: '1px solid var(--line)' }}>
              <div className="av" style={{ fontSize: 22 }}>{CAT_ICONS[d.category] || '📁'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.title || d.filename}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {d.category} · {d.site_name || 'Company-wide'} · {timeAgo(d.created_at)}
                </div>
              </div>
              <span style={{ fontSize: 18 }}>↗</span>
            </a>
          ))}
        </div>
      )}

      <button className="fab" onClick={openUpload}>+</button>
    </div>
  );
}
