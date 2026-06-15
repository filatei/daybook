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
      setOpen(results.length > 0);
      setActive(-1);
    } catch {
      setItems([]); setOpen(false);
    }
  }, [fetchFn, minChars]);

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

  const handleKeyDown = (e) => {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      setOpen(false); setActive(-1);
    }
  };

  // Reopen suggestion list if user clicks back into the field and has text
  const handleFocus = () => {
    if (value.length >= minChars && items.length > 0) setOpen(true);
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
      {open && (
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
        </div>
      )}
    </div>
  );
}
