/**
 * Typeahead — generic predictive-input dropdown
 *
 * Usage:
 *   <Typeahead
 *     value={customerName}
 *     onChange={setCustomerName}
 *     fetchFn={async (q) => [{ label: 'Alice', sub: '08012345678' }, ...]}
 *     placeholder="Customer name…"
 *   />
 *
 * fetchFn receives the current query string and must return
 * an array of { label: string, sub?: string } objects.
 * Results appear after minChars characters (default 2), debounced 220ms.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';

export default function Typeahead({
  value = '',
  onChange,
  onPick,            // optional: fires with the full picked item (carries extra fields)
  fetchFn,
  placeholder = '',
  minChars = 2,
  className = '',
  style,
  disabled,
  id,
  allowCreate = false,   // show a "➕ Add '<typed>'" row so a new entry is clearly accepted
  createLabel = (q) => `➕ Add “${q}”`,
}) {
  const [items,  setItems]  = useState([]);
  const [open,   setOpen]   = useState(false);
  const [active, setActive] = useState(-1);
  const timer  = useRef(null);
  const wrapRef = useRef(null);

  // Run the fetch after a short debounce
  const runFetch = useCallback(async (q) => {
    if (!fetchFn || q.length < minChars) {
      setItems([]); setOpen(false); return;
    }
    try {
      const results = (await fetchFn(q)) || [];
      setItems(results);
      setOpen(results.length > 0 || allowCreate);   // keep open to offer "add new"
      setActive(-1);
    } catch {
      setItems([]); setOpen(allowCreate && q.length >= minChars);
    }
  }, [fetchFn, minChars, allowCreate]);

  const handleChange = (e) => {
    const v = e.target.value;
    onChange(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runFetch(v), 220);
  };

  const pick = (item) => {
    if (onPick) onPick(item);          // caller handles the selection (e.g. add to cart)
    else onChange(item.label);
    setItems([]); setOpen(false); setActive(-1);
  };

  // "Add new" affordance: offered when the typed text isn't already an exact match.
  const q = (value || '').trim();
  const hasExact = items.some((it) => String(it.label).trim().toLowerCase() === q.toLowerCase());
  const showCreate = allowCreate && q.length >= minChars && !hasExact;
  const createNew = () => { onChange(q); setItems([]); setOpen(false); setActive(-1); };

  const handleKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (active >= 0 && items[active]) { e.preventDefault(); pick(items[active]); }
      else if (showCreate) { e.preventDefault(); createNew(); }
    } else if (e.key === 'Escape') {
      setOpen(false); setActive(-1);
    }
  };

  // Reopen suggestion list if user clicks back into the field and has text
  const handleFocus = () => {
    if (value.length >= minChars && (items.length > 0 || allowCreate)) setOpen(true);
  };

  // Close on click outside
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setActive(-1);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Cleanup debounce timer
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className={`ta${className ? ' ' + className : ''}`} ref={wrapRef} style={style}>
      <input
        id={id}
        className="input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
      {open && (items.length > 0 || showCreate) && (
        <div className="ta-list">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className={`ta-item${i === active ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              <div style={{ fontWeight: 600 }}>{item.label}</div>
              {item.sub && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{item.sub}</div>
              )}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              className="ta-item"
              onMouseDown={(e) => { e.preventDefault(); createNew(); }}
              style={{ color: 'var(--brand-d)', fontWeight: 700, borderTop: items.length ? '1px solid var(--line)' : 'none' }}
            >
              {createLabel(q)}
              {items.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, marginTop: 1 }}>Not in list — add as new</div>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
