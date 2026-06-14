# Rebuilding Fido as `fido.torama.money` — Architecture Decision Record

**Status:** Proposed (awaiting your go / override)
**Date:** 2026-06-14
**Decider:** Torama (you make the call; this is my recommendation)
**Context inputs:** live Fido backend (`tor-pos-backend`, ~34k LOC, 65 Mongo models, 65 routes), Fido Mongo dump (~57 collections, multi-GB), Daybook codebase, and your attached MT5-style resilience notes.

---

## The question

Rebuild `fido.torama.ng` (today: Ionic frontend + Node/Mongo backend on its own server) as `fido.torama.money` — containerised like otuburu/daybook, on the same server, new tech, better UX, and an architecture that survives poor internet the way MT5 does. Open sub-questions you delegated to me: **(a)** Mongo or Postgres, **(b)** Ionic → React / React Native, **(c)** separate new project, or let Daybook absorb Fido.

## TL;DR — my recommendation

1. **Not a separate from-scratch project.** Build `fido.torama.money` from the **Daybook codebase**, as its own **containerised deployment** on a heavier runtime tier. Rationale below — the short version is that the offline pattern you want already lives in Daybook, so this is *evolution, not rewrite*.
2. **Postgres** as the new source of truth (plus **Redis** for the live tier). Not Mongo.
3. **React PWA first** (Vite + React), drop Ionic. Wrap in **Capacitor** later only if native hardware (Bluetooth/USB thermal printers, gate scanners) demands it. **React Native only as a last resort** — it would duplicate the frontend for marginal gain over a good PWA.
4. Adopt your attached **MT5 resilience architecture** as Fido's transport layer: stateless WS gateway + authoritative server-side core + outbox + monotonic sequence + resume protocol + idempotency keys.

## Why "evolve Daybook" beats "new project"

The single most important fact: **the resilience pattern you sketched is already running in Daybook in miniature.** The offline-first sales I shipped use a client-generated `client_uid` (a UUID) as an **idempotency key**, queue writes in a local **outbox**, replay on reconnect, and the server **upserts on that key so a re-sent sale never double-posts**. That is exactly the "idempotent orders" pattern from your notes (`client_order_id` → server upserts → returns existing instead of opening a second position). We don't need to invent it — we need to deepen it.

Daybook also already gives you, for free, the parts a from-scratch Fido rebuild would have to redo: Google auth, multi-tenant memberships + roles, daily reports, POS (products/customers/sales/inventory/receipts), staff & timesheets, generators, staff chat + notifications, and the AI assistant over live data. That's roughly a third of Fido's surface, already built and tested. Starting `fido.torama.money` as a blank repo throws that away and creates two POS systems to maintain forever.

So: **one codebase, two runtime tiers.**

- **Light tier** (today's Daybook): SQLite, single container. Perfect for small SaaS tenants and trials. Unchanged.
- **Heavy tier** (`fido.torama.money`): Postgres + Redis + stateless WS gateway + outbox publisher. Same Docker image, different compose profile and env. This is where Fido — revenue-critical, high-volume, payment rails, logistics, printing — runs, isolated and independently scalable.

Fido gets its **own container and subdomain** (like otuburu/daybook), not "just another row in the main Daybook tenants table," because it needs the heavy runtime that light tenants don't, and because you don't want a small SaaS client's traffic anywhere near Fido's cash path.

## Decision (b): Postgres, not Mongo

Your attached design decides this for us. It rests on transactional guarantees Mongo makes awkward and Postgres makes trivial:

- **Outbox in the same transaction** as the state change — needs a real ACID transaction spanning the business table and the event table. This is the textbook Postgres pattern.
- **Monotonic sequence numbers** + a **durable, replayable event log** — a Postgres sequence + an append-only `outbox`/`events` table is the canonical implementation.
- **Idempotency keys** — a `UNIQUE` constraint on `client_order_id` is a one-liner and the DB enforces no-double-fire for you.
- **Money wants ACID.** Order lifecycle `pending → accepted → filled/cancelled`, balances, payment reconciliation — all safer with relational integrity and constraints.
- **Continuity:** Daybook is already SQL (SQLite). Postgres is "SQLite grown up" — same query paradigm, no second mental model for the team.

Keep the existing Mongo **as a read-only migration source** during cutover, then retire it. (Reporting/analytics that loved Mongo aggregation move to SQL views/materialised views.)

## Decision (c): React PWA now, Capacitor later, React Native only if forced

You asked "react-native?". My answer: **start with a React PWA, not React Native.**

- A PWA is **installable, offline-first, and updates instantly** with no app-store review — which is exactly what "iterate fast in poor-internet depots" needs. Ionic was already a webview; moving to a clean React PWA is a straight upgrade, not a platform bet.
- The hardware arguments for going native (thermal printing, scanners, background sync, push) increasingly have **web equivalents**: WebUSB / Web Bluetooth, QZ Tray (already a Fido dependency), Web Push, Background Sync.
- When a genuine native need appears, **wrap the same React code in Capacitor** — you reuse the entire frontend. That's hours, not months.
- **React Native would mean a second, separate UI codebase.** Only worth it if a hard requirement (e.g. a specific Bluetooth printer SDK) can't be met on the web. Don't pay that cost up front.

## How your MT5 notes map to the build

| Your note | Implementation in the heavy tier |
|---|---|
| Client never owns financial truth | Postgres is authoritative; client holds a view + `last_seq`, never the ledger |
| Engine runs even if client offline (EA-on-VPS) | Order/sale/gate/loading lifecycle is a **server-side state machine**; progresses regardless of who's connected |
| Idempotent orders (`client_order_id`) | UUID idempotency key, server upserts — **already in Daybook**, deepened |
| Stateless WS gateway | Thin gateway: auth, subscription fan-out, resume protocol; session+sequence state in **Redis**, not gateway memory → any instance serves any reconnect, runs several, sits behind Cloudflare |
| Reliable broadcasts | **Outbox pattern** — event written in the same transaction as the commit; a publisher tails the outbox → pushes to gateways → replayable |
| Lean wire protocol | **MessagePack** + `permessage-deflate`; snapshot-on-subscribe then **deltas with monotonic seq**; **conflation** on high-frequency channels (keep latest, drop stale) |
| Silent-recovery / resume | Heartbeat ping/pong (seconds); reconnect with **exponential backoff + jitter**; `last_seq` → replay from Redis **ring buffer**, or fresh snapshot + new baseline if the gap is too large (flicker, not logout) |
| Decide engine model early | **Single-threaded, authoritative core** first (simplest + correct); optimise only after parity |

## Phased roadmap (strangler-fig, never big-bang)

Fido runs real depots collecting cash — every cutover must be reversible and reconciled.

- **Phase 0 — Foundations.** ADR sign-off. Provision Postgres + Redis containers; stand up `fido.torama.money` skeleton (container, Apache vhost, Let's Encrypt, CI) mirroring the otuburu/daybook setup.
- **Phase 1 — Resilience core (the reusable asset).** Build the WS gateway + outbox publisher + resume protocol + idempotency as a shared library in the Daybook repo. Prove it on sales + gate + loading. (Gate/loading — queue item #20 — is built **here**, on this tier, not naively in the light tier.)
- **Phase 2 — React PWA shell.** Migrate the hot screens first: sell, gate, loading, dashboard. Offline-first from day one.
- **Phase 3 — Port Fido modules behind flags.** Payments (Flutterwave/Monnify/Mastercard/ToramaPay), distributor/vehicle/loading logistics, reconciliation (`recuploads`), payroll engine, QA/QC, cashback, claims/liabilities, produce line, terminals. One at a time; **dual-write + reconcile** against live Mongo.
- **Phase 4 — Data migration.** ETL Mongo → Postgres, staged, idempotent, reconciled to the kobo. `fidoorders` (≈495 MB) and `recuploads` (≈235 MB) are the heavy ones.
- **Phase 5 — Cutover.** POS write-path moves last, once printing + payments + gate/loading are proven in **shadow mode**. Freeze old Fido; migrate history; flip DNS.

## Risks & honest caveats

- **Revenue-critical.** Any regression hurts cash collection. Mitigation: shadow mode + reconcile before every cutover.
- **Payment rails** must be re-integrated and re-certified — slowest external dependency.
- **Thermal printing parity** must be proven on real hardware before POS cutover.
- **Data volume.** Multi-GB migration needs staging + verification, not a one-shot dump.
- **Scope honesty.** Fido is ~34k LOC and 65 domain models; Daybook covers ~a third today. This is a **multi-month** programme, not a sprint. The win is one modern, offline-first, multi-tenant engine that *also* resells to other businesses — but only if run as a staged migration.

## What I need from you to start Phase 0

1. **Confirm or override** the three calls: Postgres ✓, React PWA ✓, shared-codebase/own-deployment ✓.
2. Confirm `fido.torama.money` on the **same Linode** as otuburu/daybook (139.162.170.253), or a dedicated box given Fido's load.
3. Anything in the current Fido you consider sacred / must-not-change (workflows, receipt formats, payment providers).

Default if you just say "go": I proceed exactly as above.
