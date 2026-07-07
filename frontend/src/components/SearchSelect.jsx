/**
 * SearchSelect — a searchable <select> replacement.
 *
 * Drop-in for a native <select> when the option list is long. Shows the selected
 * label as a button; clicking opens a searchable, keyboard-navigable dropdown
 * with optional grouping. Reuses the .ta / .ta-list / .ta-item styles used by
 * Typeahead, so it looks native to the app.
 *
 * Props:
 *   value            current value (string)
 *   onChange         (value) => void
 *   options          [{ value, label, sub?, group? }]
 *   placeholder      shown when nothing selected (default "Select…")
 *   searchPlaceholder text in the search box (default "Search…")
 *   searchable       show the search box (default true)
 *   groupOrder       optional array of group names to order groups
 *   disabled, id, className, style
 *
 * Portable across projects: no dependencies beyond React. To reuse elsewhere,
 * copy this file and ensure the .ta / .ta-list / .ta-item CSS classes exist
 * (or restyle via className/style).
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';

export default function SearchSelect({
  value = '',
  onChange,
  options = [],
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  searchable = true,
  groupOrder,
  disabled,
  id,
  className = '',
  style,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)) || null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter((o) =>
      [o.label, o.sub, o.group, o.value].filter(Boolean).join(' ').toLowerCase().includes(s));
  }, [options, q]);

  // Group filtered options (preserving encounter order); '' group = ungrouped.
  const groups = useMemo(() => {
    const m = new Map();
    for (const o of filtered) {
      const g = o.group || '';
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(o);
    }
    let keys = Array.from(m.keys());
    if (groupOrder) keys.sort((a, b) => groupOrder.indexOf(a) - groupOrder.indexOf(b));
    return keys.map((k) => ({ group: k, items: m.get(k) }));
  }, [filtered, groupOrder]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const close = useCallback(() => { setOpen(false); setQ(''); setActive(-1); }, []);
  const pick = (o) => { if (onChange) onChange(o.value); close(); };

  useEffect(() => { if (open && searchable && inputRef.current) inputRef.current.focus(); }, [open, searchable]);

  useEffect(() => {
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [close]);

  const onKey = (e) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && flat[active]) pick(flat[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return (
    <div className={`ta ss${className ? ' ' + className : ''}`} ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        id={id}
        className="input"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onKey}
        style={{ textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: disabled ? 'default' : 'pointer', width: '100%' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--ink)' : 'var(--muted)' }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, flex: '0 0 auto' }}>▾</span>
      </button>
      {open && (
        <div className="ta-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {searchable && (
            <input
              ref={inputRef}
              className="input"
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(-1); }}
              onKeyDown={onKey}
              placeholder={searchPlaceholder}
              autoComplete="off"
              spellCheck={false}
              style={{ position: 'sticky', top: 0, margin: 0, borderRadius: 0, borderWidth: '0 0 1px 0', zIndex: 1 }}
            />
          )}
          {flat.length === 0 && <div className="ta-item" style={{ color: 'var(--muted)' }}>No matches</div>}
          {groups.map((g) => (
            <React.Fragment key={g.group || '_'}>
              {g.group && (
                <div style={{ padding: '6px 10px 2px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{g.group}</div>
              )}
              {g.items.map((o) => {
                const idx = flat.indexOf(o);
                const isSel = String(o.value) === String(value);
                return (
                  <button
                    key={String(o.value) + '|' + o.label}
                    type="button"
                    className={`ta-item${idx === active ? ' on' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                    style={isSel ? { background: 'var(--surface2, #eef2ff)' } : undefined}
                  >
                    <div style={{ fontWeight: 600 }}>{o.label}{isSel ? ' ✓' : ''}</div>
                    {o.sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{o.sub}</div>}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
