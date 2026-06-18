import React from 'react';

// Minimal, safe Markdown → React renderer (no dangerouslySetInnerHTML, no deps).
// Handles what the AI assistant actually emits: headings, **bold**, *italic*,
// `code`, bullet & numbered lists, and paragraphs with line breaks.

function inline(text, base) {
  const nodes = [];
  let rest = String(text);
  let k = 0;
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|_([^_]+)_)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    if (m[2] != null) nodes.push(<strong key={`${base}-${k}`}>{m[2]}</strong>);
    else if (m[3] != null) nodes.push(<code key={`${base}-${k}`} className="md-code">{m[3]}</code>);
    else if (m[4] != null) nodes.push(<em key={`${base}-${k}`}>{m[4]}</em>);
    else if (m[5] != null) nodes.push(<em key={`${base}-${k}`}>{m[5]}</em>);
    rest = rest.slice(m.index + m[1].length);
    k++;
  }
  if (rest) nodes.push(rest);
  return nodes;
}

const isBullet = (l) => /^\s*[-*]\s+/.test(l);
const isNumber = (l) => /^\s*\d+\.\s+/.test(l);
const isHeading = (l) => /^(#{1,3})\s+/.test(l);

export default function Markdown({ text }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const hm = line.match(/^(#{1,3})\s+(.*)/);
    if (hm) { blocks.push(<div key={`h${i}`} className="md-h" style={{ fontSize: hm[1].length === 1 ? 16 : 14 }}>{inline(hm[2], i)}</div>); i++; continue; }

    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      blocks.push(<ul key={`ul${i}`} className="md-list">{items.map((it, j) => <li key={j}>{inline(it, `${i}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (isNumber(line)) {
      const items = [];
      while (i < lines.length && isNumber(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(<ol key={`ol${i}`} className="md-list">{items.map((it, j) => <li key={j}>{inline(it, `${i}-${j}`)}</li>)}</ol>);
      continue;
    }

    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isHeading(lines[i]) && !isBullet(lines[i]) && !isNumber(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(
      <p key={`p${i}`} className="md-p">
        {para.map((pl, j) => (
          <React.Fragment key={j}>{inline(pl, `${i}-${j}`)}{j < para.length - 1 ? <br /> : null}</React.Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
