/**
 * Daybook — End-of-day POS capture.
 *
 * Each site photographs the EOD slip printed by every POS terminal. The photo is
 * read by AI (Claude vision), the figures come back as structured JSON, and the
 * user corrects anything the AI could not read cleanly before saving. One row per
 * terminal per business day.
 *
 * The point of the feature is the VARIANCE: the terminal's own approved total vs
 * what was actually keyed into Daybook as POS sales for that terminal/date. A gap
 * means sales went through the machine but never reached the books (or vice-versa).
 *
 * AI is optional — if AI_API_KEY is unset, extraction returns an empty form and the
 * user types the numbers by hand. The feature must never hard-depend on the AI.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound } = require('./auth');
const { callAI, AIError, aiConfigured } = require('./aiClient');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const IMG_OK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.pdf']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_q, f, cb) => cb(null, `${Date.now()}-${uuid().slice(0, 8)}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_MB || '25', 10) * 1024 * 1024 },
  fileFilter: (_q, f, cb) => { const ok = IMG_OK.has(path.extname(f.originalname).toLowerCase()); cb(ok ? null : new Error('Upload a photo of the slip (png/jpg/webp/heic/pdf)'), ok); },
});

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
const nowS = () => Math.floor(Date.now() / 1000);
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int0 = (v) => Math.max(0, parseInt(v, 10) || 0);

// EOD is site-floor work: secretaries capture, accountants review the summary.
async function needCtx(req, res, minRole = 'SECRETARY') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// ── AI extraction ─────────────────────────────────────────────────────────────
// The model returns ONLY JSON. `unclear` lets the UI highlight the fields it could
// not read with confidence, so the user checks exactly those instead of all of them.
const EXTRACT_SYSTEM = `You read photographs of Nigerian POS terminal end-of-day (EOD) summary slips and return the figures as JSON.

A slip typically has a header (merchant name, address, TERMINAL ID, DATE) and two sections:
  "PURCHASE SUMMARY"     — card purchases
  "POS TRANSFER SUMMARY" — bank transfers taken on the terminal
Each section lists counts (TOTAL VOLUME, SUCCESSFUL/APPROVED, FAILED/REJECTED, PENDING)
and amounts (APPROVED AMOUNT, PENDING AMOUNT, FAILED/REJECTED AMOUNT).

Return ONLY a JSON object, no prose, no markdown fence:
{
  "terminal_id": string|null,
  "business_date": "YYYY-MM-DD"|null,
  "slip_time": string|null,
  "purchase": { "volume": int, "successful": int, "failed": int, "pending": int,
                "approved_amount": number, "pending_amount": number, "failed_amount": number },
  "transfer": { "volume": int, "approved": int, "rejected": int, "pending": int,
                "approved_amount": number, "pending_amount": number, "rejected_amount": number },
  "unclear": [string]
}

Rules:
- Amounts are Naira. Strip "NGN", commas and currency symbols: "NGN22,500.00" -> 22500.00
- Use 0 for a count/amount that is genuinely zero on the slip.
- If a value is unreadable, blurred or cut off, set it to 0 (or null for text) AND add its
  dotted path to "unclear", e.g. "purchase.approved_amount" or "terminal_id".
- Dates may print as DD/MM/YYYY or "Sat Jul 18 2026" — always output YYYY-MM-DD.
- If the slip shows both a header DATE and a section date, prefer the section (PURCHASE SUMMARY) date.
- Never invent figures. Unreadable means unclear, not guessed.`;

const EMPTY_EXTRACT = {
  terminal_id: null, business_date: null, slip_time: null,
  purchase: { volume: 0, successful: 0, failed: 0, pending: 0, approved_amount: 0, pending_amount: 0, failed_amount: 0 },
  transfer: { volume: 0, approved: 0, rejected: 0, pending: 0, approved_amount: 0, pending_amount: 0, rejected_amount: 0 },
  unclear: [],
};

// Pull the JSON object out of a model reply that may still wrap it in prose/fences.
function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// Normalise whatever the model returned into the exact shape the UI expects, so a
// missing key can never blow up the form.
function normalise(x) {
  const p = (x && x.purchase) || {}, t = (x && x.transfer) || {};
  const date = (x && typeof x.business_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.business_date)) ? x.business_date : null;
  return {
    terminal_id: (x && x.terminal_id != null) ? String(x.terminal_id).trim().toUpperCase() || null : null,
    business_date: date,
    slip_time: (x && x.slip_time) ? String(x.slip_time).trim() : null,
    purchase: {
      volume: int0(p.volume), successful: int0(p.successful), failed: int0(p.failed), pending: int0(p.pending),
      approved_amount: n2(p.approved_amount), pending_amount: n2(p.pending_amount), failed_amount: n2(p.failed_amount),
    },
    transfer: {
      volume: int0(t.volume), approved: int0(t.approved), rejected: int0(t.rejected), pending: int0(t.pending),
      approved_amount: n2(t.approved_amount), pending_amount: n2(t.pending_amount), rejected_amount: n2(t.rejected_amount),
    },
    unclear: Array.isArray(x && x.unclear) ? x.unclear.filter((s) => typeof s === 'string').slice(0, 30) : [],
  };
}

/**
 * POST /eod/extract  (multipart: file)
 * Reads the slip and returns the figures for the user to confirm. Does NOT save.
 * Keeps the uploaded file so the save step can reference it without re-uploading.
 */
router.post('/extract', requireAuth, upload.single('file'), async (req, res) => {
  const c = await needCtx(req, res); if (!c) { return; }
  if (!req.file) return res.status(400).json({ error: 'attach a photo of the EOD slip' });

  const stored = req.file.filename;
  const ext = path.extname(stored).toLowerCase();
  const base = { file: { stored_name: stored, file_name: req.file.originalname, mime: req.file.mimetype } };

  // AI is a convenience, never a hard dependency — fall back to a blank form.
  if (!aiConfigured || !aiConfigured()) {
    return res.json({ ...base, ai: false, reason: 'AI not configured — enter the figures manually', extract: EMPTY_EXTRACT });
  }
  if (ext === '.pdf' || !MIME[ext]) {
    return res.json({ ...base, ai: false, reason: 'Only photos can be read automatically — enter the figures manually', extract: EMPTY_EXTRACT });
  }

  try {
    const b64 = fs.readFileSync(path.join(UPLOAD_DIR, stored)).toString('base64');
    const reply = await callAI({
      system: EXTRACT_SYSTEM,
      maxTokens: 900,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: MIME[ext], data: b64 } },
          { type: 'text', text: 'Extract the EOD figures from this POS slip as JSON.' },
        ],
      }],
    });
    const parsed = parseJsonReply(typeof reply === 'string' ? reply : (reply && reply.text) || '');
    if (!parsed) return res.json({ ...base, ai: false, reason: 'Could not read the slip — enter the figures manually', extract: EMPTY_EXTRACT });

    const extract = normalise(parsed);
    // Resolve the terminal to a site/bank we already know about.
    let match = null;
    if (extract.terminal_id) {
      match = await qone(
        'SELECT id, site_id, bank, label FROM pos_terminals WHERE tenant_id=? AND UPPER(COALESCE(terminal_id,\'\'))=? LIMIT 1',
        [c.tenant_id, extract.terminal_id]);
    }
    res.json({ ...base, ai: true, extract, terminal: match || null, raw: JSON.stringify(parsed).slice(0, 4000) });
  } catch (e) {
    const msg = e instanceof AIError ? e.userMessage : 'Could not read the slip automatically';
    res.json({ ...base, ai: false, reason: `${msg} — enter the figures manually`, extract: EMPTY_EXTRACT });
  }
});

// ── Save / update ─────────────────────────────────────────────────────────────
/**
 * POST /eod — save the confirmed figures (upsert on terminal + business_date).
 * Body carries the (possibly user-corrected) numbers plus the stored file name
 * returned by /extract.
 */
router.post('/', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const business_date = String(b.business_date || today()).slice(0, 10);
  const terminal_id = String(b.terminal_id || '').trim().toUpperCase() || null;
  if (!terminal_id) return res.status(400).json({ error: 'terminal ID is required' });

  // Site: bound users always record against their own site.
  let site_id = siteBound(c) ? c.site_id : (b.site_id || null);
  let bank = (b.bank || '').trim() || null;
  let posTerminal = null;
  const match = await qone('SELECT id, site_id, bank FROM pos_terminals WHERE tenant_id=? AND UPPER(COALESCE(terminal_id,\'\'))=? LIMIT 1',
    [c.tenant_id, terminal_id]);
  if (match) { posTerminal = match.id; site_id = site_id || match.site_id; bank = bank || match.bank; }
  if (!site_id) return res.status(400).json({ error: 'site is required (terminal not recognised — pick a site)' });

  const p = b.purchase || {}, t = b.transfer || {};
  const id = uuid();
  const row = [
    id, c.tenant_id, site_id, terminal_id, posTerminal, bank, business_date,
    int0(p.volume), int0(p.successful), int0(p.failed), int0(p.pending),
    n2(p.approved_amount), n2(p.pending_amount), n2(p.failed_amount),
    int0(t.volume), int0(t.approved), int0(t.rejected), int0(t.pending),
    n2(t.approved_amount), n2(t.pending_amount), n2(t.rejected_amount),
    (b.slip_time || null), (b.note || null),
    (b.file_name || null), (b.stored_name || null), (b.mime || null),
    (b.ai_json || null), (Array.isArray(b.unclear) ? JSON.stringify(b.unclear) : null),
    !!b.edited, req.user.id, nowS(),
  ];
  // Re-uploading the same terminal/day replaces the figures (a corrected slip wins).
  await qrun(`INSERT INTO pos_eod
      (id,tenant_id,site_id,terminal_id,pos_terminal,bank,business_date,
       p_volume,p_successful,p_failed,p_pending,p_approved,p_pending_amt,p_failed_amt,
       t_volume,t_approved_n,t_rejected,t_pending,t_approved,t_pending_amt,t_rejected_amt,
       slip_time,note,file_name,stored_name,mime,ai_json,ai_unclear,edited,captured_by,updated_at)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id, COALESCE(terminal_id,''), business_date) DO UPDATE SET
       site_id=EXCLUDED.site_id, pos_terminal=EXCLUDED.pos_terminal, bank=EXCLUDED.bank,
       p_volume=EXCLUDED.p_volume, p_successful=EXCLUDED.p_successful, p_failed=EXCLUDED.p_failed,
       p_pending=EXCLUDED.p_pending, p_approved=EXCLUDED.p_approved,
       p_pending_amt=EXCLUDED.p_pending_amt, p_failed_amt=EXCLUDED.p_failed_amt,
       t_volume=EXCLUDED.t_volume, t_approved_n=EXCLUDED.t_approved_n, t_rejected=EXCLUDED.t_rejected,
       t_pending=EXCLUDED.t_pending, t_approved=EXCLUDED.t_approved,
       t_pending_amt=EXCLUDED.t_pending_amt, t_rejected_amt=EXCLUDED.t_rejected_amt,
       slip_time=EXCLUDED.slip_time, note=EXCLUDED.note,
       file_name=COALESCE(EXCLUDED.file_name, pos_eod.file_name),
       stored_name=COALESCE(EXCLUDED.stored_name, pos_eod.stored_name),
       mime=COALESCE(EXCLUDED.mime, pos_eod.mime),
       ai_json=EXCLUDED.ai_json, ai_unclear=EXCLUDED.ai_unclear, edited=EXCLUDED.edited,
       captured_by=EXCLUDED.captured_by, updated_at=EXCLUDED.updated_at`, row);

  const saved = await qone('SELECT * FROM pos_eod WHERE tenant_id=? AND COALESCE(terminal_id,\'\')=? AND business_date=?',
    [c.tenant_id, terminal_id, business_date]);
  res.status(201).json(saved);
});

// ── Read: list + per-site summary + variance vs recorded POS sales ────────────
/**
 * GET /eod?from=&to=&site=
 * Returns each EOD row with `recorded` (what Daybook has as POS sales for that
 * terminal/date) and `variance` (eod_total − recorded), plus per-site totals.
 */
router.get('/', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const from = String(req.query.from || today()).slice(0, 10);
  const to = String(req.query.to || from).slice(0, 10);
  const where = ['e.tenant_id=?', 'e.business_date BETWEEN ? AND ?'], args = [c.tenant_id, from, to];
  if (siteBound(c)) { where.push('e.site_id=?'); args.push(c.site_id); }
  else if (req.query.site) { where.push('e.site_id=?'); args.push(req.query.site); }

  const rows = await qall(`SELECT e.*, s.name site_name, u.name captured_by_name
    FROM pos_eod e LEFT JOIN sites s ON s.id=e.site_id LEFT JOIN users u ON u.id=e.captured_by
    WHERE ${where.join(' AND ')} ORDER BY e.business_date DESC, s.name, e.terminal_id`, args);

  // What Daybook itself recorded on those terminals over the same window. Matching
  // is by terminal text (pos_sales.terminal), which is how sales are tagged today.
  const recorded = await qall(`SELECT UPPER(COALESCE(terminal,'')) term, sale_date, COALESCE(SUM(total),0) amt, COUNT(*) n
    FROM pos_sales WHERE tenant_id=? AND sale_date BETWEEN ? AND ?
      AND UPPER(COALESCE(payment_method,'')) <> 'CASH'
    GROUP BY 1,2`, [c.tenant_id, from, to]);
  const recMap = {};
  for (const r of recorded) recMap[`${r.term}|${r.sale_date}`] = { amount: Number(r.amt), count: Number(r.n) };

  const out = rows.map((e) => {
    const eodTotal = n2(Number(e.p_approved || 0) + Number(e.t_approved || 0));
    const rec = recMap[`${String(e.terminal_id || '').toUpperCase()}|${e.business_date}`] || { amount: 0, count: 0 };
    return {
      ...e,
      unclear: (() => { try { return JSON.parse(e.ai_unclear || '[]'); } catch { return []; } })(),
      eod_total: eodTotal,
      recorded_total: n2(rec.amount),
      recorded_count: rec.count,
      // Positive → the machine took more than the books show (likely unrecorded sales).
      variance: n2(eodTotal - rec.amount),
    };
  });

  // Per-site roll-up so the accountant sees the day at a glance.
  const bySite = {};
  for (const r of out) {
    const k = r.site_id || '—';
    const s = bySite[k] || (bySite[k] = { site_id: r.site_id, site: r.site_name || '—', terminals: 0, purchase: 0, transfer: 0, eod_total: 0, recorded_total: 0, variance: 0 });
    s.terminals += 1;
    s.purchase = n2(s.purchase + Number(r.p_approved || 0));
    s.transfer = n2(s.transfer + Number(r.t_approved || 0));
    s.eod_total = n2(s.eod_total + r.eod_total);
    s.recorded_total = n2(s.recorded_total + r.recorded_total);
    s.variance = n2(s.variance + r.variance);
  }
  const sites = Object.values(bySite).sort((a, b) => String(a.site).localeCompare(String(b.site)));
  const totals = sites.reduce((a, s) => ({
    terminals: a.terminals + s.terminals, purchase: n2(a.purchase + s.purchase), transfer: n2(a.transfer + s.transfer),
    eod_total: n2(a.eod_total + s.eod_total), recorded_total: n2(a.recorded_total + s.recorded_total), variance: n2(a.variance + s.variance),
  }), { terminals: 0, purchase: 0, transfer: 0, eod_total: 0, recorded_total: 0, variance: 0 });

  res.json({ from, to, rows: out, sites, totals });
});

// Serve the stored slip photo (evidence).
router.get('/:id/photo', requireAuth, async (req, res) => {
  const e = await qone('SELECT * FROM pos_eod WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).end();
  const c = await contextFor(req.user, e.tenant_id);
  if (!c) return res.status(403).end();
  if (siteBound(c) && e.site_id && e.site_id !== c.site_id) return res.status(403).end();
  if (!e.stored_name) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, e.stored_name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', e.mime || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});

// Remove an EOD entry — Accountant+ (a wrong slip shouldn't linger in the totals).
router.delete('/:id', requireAuth, async (req, res) => {
  const e = await qone('SELECT * FROM pos_eod WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, e.tenant_id);
  if (!c || !atLeast(c.role, 'ACCOUNTANT')) return res.status(403).json({ error: 'only an accountant can delete an EOD entry' });
  await qrun('DELETE FROM pos_eod WHERE id=?', [e.id]);
  res.json({ ok: true });
});

module.exports = router;
