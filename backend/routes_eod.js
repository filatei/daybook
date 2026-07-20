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

// ── AI spend: pricing, quotas, ledger ────────────────────────────────────────
// Per-million-token rates so cost can be attributed per user/site. Override with
// AI_PRICE_IN / AI_PRICE_OUT when the model or provider changes.
const PRICE_IN = parseFloat(process.env.AI_PRICE_IN || '1');    // $/MTok input  (Haiku 4.5)
const PRICE_OUT = parseFloat(process.env.AI_PRICE_OUT || '5');  // $/MTok output
const USD_NGN = parseFloat(process.env.USD_TO_NGN_RATE || '1600');
const costUsd = (u) => ((u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT) / 1e6;

// Daily ceilings — stop a stuck loop or a bored user burning credit. Generous
// enough that honest use never notices; low enough that abuse is capped.
const MAX_PER_USER_DAY = parseInt(process.env.AI_MAX_PER_USER_DAY || '40', 10);
const MAX_PER_TENANT_DAY = parseInt(process.env.AI_MAX_PER_TENANT_DAY || '300', 10);

const dayStart = () => Math.floor(new Date(new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' }) + 'T00:00:00Z').getTime() / 1000);

// Returns null when allowed, or a message when the caller is over quota.
async function quotaBlock(tenant_id, user_id) {
  const since = dayStart();
  const [mine, theirs] = await Promise.all([
    qone('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND created_at>=?', [user_id, since]),
    qone('SELECT COUNT(*) c FROM ai_usage WHERE tenant_id=? AND created_at>=?', [tenant_id, since]),
  ]);
  if (Number(mine?.c || 0) >= MAX_PER_USER_DAY) return `You've used the ${MAX_PER_USER_DAY} daily slip reads. Enter the figures manually, or try again tomorrow.`;
  if (Number(theirs?.c || 0) >= MAX_PER_TENANT_DAY) return `This workspace has reached its ${MAX_PER_TENANT_DAY} daily slip reads. Enter the figures manually.`;
  return null;
}

async function logUsage({ tenant_id, site_id, user_id, model, usage, ok }) {
  const id = uuid();
  await qrun(`INSERT INTO ai_usage (id,tenant_id,site_id,user_id,feature,model,input_tokens,output_tokens,cost_usd,ok,used,created_at)
    VALUES (?,?,?,?,'eod_extract',?,?,?,?,?,FALSE,?)`,
  [id, tenant_id, site_id || null, user_id, model || null,
    usage?.input_tokens || 0, usage?.output_tokens || 0, costUsd(usage || {}), ok !== false, nowS()]).catch(() => {});
  return id;
}

// ── Group roll-up ─────────────────────────────────────────────────────────────
// The Group workspace is SYNTHETIC — invented by the frontend (store.jsx
// GROUP_ID), with no row in `tenants`. Same treatment as payroll: resolve it to
// the set of tenants this user can actually see, rather than 403.
//
// Reads roll up across all of them. Writes do not: capturing a slip has to land
// in one workspace, and "which one" is not something the server should guess.
const GROUP_ID = '__group__';

async function groupContexts(user, minRole) {
  const rows = await qall("SELECT id FROM tenants WHERE status='ACTIVE' ORDER BY name, id");
  const out = [];
  for (const t of rows) {
    const c = await contextFor(user, t.id);
    if (c && atLeast(c.role, minRole)) out.push(c);
  }
  return out;
}

// EOD is site-floor work: secretaries capture, accountants review the summary.
async function needCtx(req, res, minRole = 'SECRETARY') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  if (tid === GROUP_ID) {
    const ctxs = await groupContexts(req.user, minRole);
    if (!ctxs.length) { res.status(403).json({ error: 'forbidden' }); return null; }
    // Anchor on the first tenant; tenant_ids carries the real read scope.
    // site_id is cleared — a group roll-up is never site-bound.
    return { ...ctxs[0], site_id: null, group: true, tenant_ids: ctxs.map((x) => x.tenant_id) };
  }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// Every tenant in scope. Single-tenant contexts return exactly one, so callers
// need no special case.
const ctxTenants = (c) => (c && c.group && Array.isArray(c.tenant_ids) && c.tenant_ids.length ? c.tenant_ids : [c.tenant_id]);

// Parameterised IN(...) so a group read never falls back to an unscoped query —
// that is the failure mode that leaks one tenant's takings into another's view.
function scopeSql(c, col = 'tenant_id') {
  const ids = ctxTenants(c);
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, args: ids };
}

// Capture/delete must name a real workspace.
function rejectGroupWrite(c, res) {
  if (!c.group) return false;
  res.status(400).json({ error: 'Pick a workspace (Fido or Fiafia) before capturing or deleting an EOD slip.' });
  return true;
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
  if (rejectGroupWrite(c, res)) return;
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

  // Quota check BEFORE spending anything.
  const blocked = await quotaBlock(c.tenant_id, req.user.id);
  if (blocked) return res.status(429).json({ error: blocked });

  try {
    const b64 = fs.readFileSync(path.join(UPLOAD_DIR, stored)).toString('base64');
    const reply = await callAI({
      system: EXTRACT_SYSTEM,
      maxTokens: 900,
      withUsage: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: MIME[ext], data: b64 } },
          { type: 'text', text: 'Extract the EOD figures from this POS slip as JSON.' },
        ],
      }],
    });
    // Every paid call is recorded, whether or not it parsed — that's the point of
    // the ledger. `usage_id` comes back so a later save can mark it as USED.
    const usageId = await logUsage({
      tenant_id: c.tenant_id, site_id: siteBound(c) ? c.site_id : null,
      user_id: req.user.id, model: reply.usage?.model, usage: reply.usage, ok: true,
    });
    const parsed = parseJsonReply(reply.text || '');
    if (!parsed) return res.json({ ...base, ai: false, usage_id: usageId, reason: 'Could not read the slip — enter the figures manually', extract: EMPTY_EXTRACT });

    const extract = normalise(parsed);
    // Resolve the terminal to a site/bank we already know about.
    let match = null;
    if (extract.terminal_id) {
      match = await qone(
        'SELECT id, site_id, bank, label FROM pos_terminals WHERE tenant_id=? AND UPPER(COALESCE(terminal_id,\'\'))=? LIMIT 1',
        [c.tenant_id, extract.terminal_id]);
    }
    res.json({ ...base, ai: true, usage_id: usageId, extract, terminal: match || null, raw: JSON.stringify(parsed).slice(0, 4000) });
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
  if (rejectGroupWrite(c, res)) return;
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

  // Mark the AI call that produced this as USED. Extractions that never reach a
  // save are the misuse signal — spend with nothing to show for it.
  if (b.usage_id) {
    await qrun('UPDATE ai_usage SET used=TRUE, site_id=COALESCE(site_id,?) WHERE id=? AND tenant_id=?',
      [site_id, String(b.usage_id), c.tenant_id]).catch(() => {});
  }

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
  const sc = scopeSql(c, 'e.tenant_id');
  const where = [sc.sql, 'e.business_date BETWEEN ? AND ?'], args = [...sc.args, from, to];
  if (siteBound(c)) { where.push('e.site_id=?'); args.push(c.site_id); }
  else if (req.query.site) { where.push('e.site_id=?'); args.push(req.query.site); }

  // t.name comes through so the group roll-up can label which workspace a site
  // belongs to — two tenants can legitimately have a site with the same name.
  const rows = await qall(`SELECT e.*, s.name site_name, u.name captured_by_name, t.name tenant_name
    FROM pos_eod e
    LEFT JOIN sites s   ON s.id=e.site_id
    LEFT JOIN users u   ON u.id=e.captured_by
    LEFT JOIN tenants t ON t.id=e.tenant_id
    WHERE ${where.join(' AND ')} ORDER BY t.name, s.name, e.business_date DESC, e.terminal_id`, args);

  // What Daybook itself recorded on those terminals over the same window. Matching
  // is by terminal text (pos_sales.terminal), which is how sales are tagged today.
  // Keyed by tenant as well as terminal: across a group read, two workspaces
  // could use the same terminal label and their takings must not be pooled.
  const rsc = scopeSql(c, 'tenant_id');
  const recorded = await qall(`SELECT tenant_id, UPPER(COALESCE(terminal,'')) term, sale_date, COALESCE(SUM(total),0) amt, COUNT(*) n
    FROM pos_sales WHERE ${rsc.sql} AND sale_date BETWEEN ? AND ?
      AND UPPER(COALESCE(payment_method,'')) <> 'CASH'
    GROUP BY 1,2,3`, [...rsc.args, from, to]);
  const recMap = {};
  for (const r of recorded) recMap[`${r.tenant_id}|${r.term}|${r.sale_date}`] = { amount: Number(r.amt), count: Number(r.n) };

  const out = rows.map((e) => {
    const eodTotal = n2(Number(e.p_approved || 0) + Number(e.t_approved || 0));
    const rec = recMap[`${e.tenant_id}|${String(e.terminal_id || '').toUpperCase()}|${e.business_date}`] || { amount: 0, count: 0 };
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

  // Per-site roll-up so the accountant sees the day at a glance. Keyed by
  // tenant AND site: "Kpansia" can exist in both workspaces and merging them
  // would silently double a site's takings.
  const ZERO = () => ({ terminals: 0, purchase: 0, transfer: 0, eod_total: 0, recorded_total: 0, variance: 0 });
  const add = (a, r) => {
    a.terminals += 1;
    a.purchase = n2(a.purchase + Number(r.p_approved || 0));
    a.transfer = n2(a.transfer + Number(r.t_approved || 0));
    a.eod_total = n2(a.eod_total + r.eod_total);
    a.recorded_total = n2(a.recorded_total + r.recorded_total);
    a.variance = n2(a.variance + r.variance);
    return a;
  };

  const bySite = {};
  for (const r of out) {
    const k = `${r.tenant_id}|${r.site_id || '—'}`;
    const s = bySite[k] || (bySite[k] = {
      key: k, site_id: r.site_id, site: r.site_name || '—',
      tenant_id: r.tenant_id, tenant: r.tenant_name || '—', ...ZERO(),
    });
    add(s, r);
  }
  const sites = Object.values(bySite).sort((a, b) =>
    String(a.tenant).localeCompare(String(b.tenant)) || String(a.site).localeCompare(String(b.site)));

  // Tenant layer. Present even for a single workspace so the client renders one
  // shape either way, rather than branching on group mode.
  const byTenant = {};
  for (const s of sites) {
    const t = byTenant[s.tenant_id] || (byTenant[s.tenant_id] = {
      tenant_id: s.tenant_id, tenant: s.tenant, sites: 0, ...ZERO(),
    });
    t.sites += 1;
    t.terminals += s.terminals;
    t.purchase = n2(t.purchase + s.purchase);
    t.transfer = n2(t.transfer + s.transfer);
    t.eod_total = n2(t.eod_total + s.eod_total);
    t.recorded_total = n2(t.recorded_total + s.recorded_total);
    t.variance = n2(t.variance + s.variance);
  }
  const tenants = Object.values(byTenant).sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)));

  const totals = sites.reduce((a, s) => ({
    terminals: a.terminals + s.terminals, purchase: n2(a.purchase + s.purchase), transfer: n2(a.transfer + s.transfer),
    eod_total: n2(a.eod_total + s.eod_total), recorded_total: n2(a.recorded_total + s.recorded_total), variance: n2(a.variance + s.variance),
  }), ZERO());
  totals.sites = sites.length;
  totals.tenants = tenants.length;

  res.json({ from, to, group: !!c.group, rows: out, sites, tenants, totals });
});

/**
 * GET /eod/ai-usage?from=&to=  — Accountant+ only.
 * What the slip-reading has cost, broken down by site and by user, plus a waste
 * signal: reads that never became a saved EOD.
 */
router.get('/ai-usage', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'ACCOUNTANT'); if (!c) return;
  const from = String(req.query.from || today()).slice(0, 10);
  const to = String(req.query.to || from).slice(0, 10);
  const a = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const b = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);

  const usc = scopeSql(c, 'u.tenant_id');
  const rows = await qall(`SELECT u.*, s.name site_name, us.name user_name, us.email user_email
    FROM ai_usage u LEFT JOIN sites s ON s.id=u.site_id LEFT JOIN users us ON us.id=u.user_id
    WHERE ${usc.sql} AND u.created_at BETWEEN ? AND ?`, [...usc.args, a, b]);

  const roll = (keyOf, labelOf) => {
    const m = {};
    for (const r of rows) {
      const k = keyOf(r) || '—';
      const e = m[k] || (m[k] = { key: k, label: labelOf(r) || '—', reads: 0, used: 0, wasted: 0, failed: 0, cost_usd: 0 });
      e.reads += 1;
      if (r.used) e.used += 1; else e.wasted += 1;
      if (!r.ok) e.failed += 1;
      e.cost_usd += Number(r.cost_usd || 0);
    }
    return Object.values(m)
      .map((e) => ({
        ...e,
        cost_usd: Math.round(e.cost_usd * 10000) / 10000,
        cost_ngn: Math.round(e.cost_usd * USD_NGN * 100) / 100,
        // Share of paid reads that produced nothing — the misuse indicator.
        waste_pct: e.reads ? Math.round((e.wasted / e.reads) * 100) : 0,
      }))
      .sort((x, y) => y.cost_usd - x.cost_usd);
  };

  const bySite = roll((r) => r.site_id, (r) => r.site_name);
  const byUser = roll((r) => r.user_id, (r) => r.user_name || r.user_email);
  const totals = rows.reduce((t, r) => ({
    reads: t.reads + 1,
    used: t.used + (r.used ? 1 : 0),
    wasted: t.wasted + (r.used ? 0 : 1),
    failed: t.failed + (r.ok ? 0 : 1),
    cost_usd: t.cost_usd + Number(r.cost_usd || 0),
  }), { reads: 0, used: 0, wasted: 0, failed: 0, cost_usd: 0 });
  totals.cost_usd = Math.round(totals.cost_usd * 10000) / 10000;
  totals.cost_ngn = Math.round(totals.cost_usd * USD_NGN * 100) / 100;
  totals.waste_pct = totals.reads ? Math.round((totals.wasted / totals.reads) * 100) : 0;

  res.json({
    from, to, totals, sites: bySite, users: byUser,
    limits: { per_user_day: MAX_PER_USER_DAY, per_tenant_day: MAX_PER_TENANT_DAY },
    rate_ngn: USD_NGN,
  });
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
