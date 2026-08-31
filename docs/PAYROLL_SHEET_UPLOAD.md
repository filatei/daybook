# Payroll sheet upload & month-end workflow

SNR ACCOUNTANT+ can upload a month-end Excel workbook and use it as the **authoritative** payroll source. The upload is also stored for an optional side-by-side check against computed attendance. Computed figures do **not** need to match the sheet.

## Bank portal file (same as mid-month)

The file the bank payroll portal accepts is **Saved → open the run → Bank portal file** (`GET /api/payroll/runs2/:id/bank.xlsx`). It works for:

- **Mid-month** drafts (built from production on the Mid-month tab)
- **Month-end SHEET** drafts (built with **Generate payroll from sheet**)
- **COMPUTED** drafts (built with Preview computed → Save payroll)

There is no separate month-end bank download. Do not use Compare as a substitute — Compare is an optional check only.

**Month-end path (same shape as mid-month):**

1. Upload the accountant's Excel
2. Generate payroll from sheet (authoritative)
3. Saved: Approve
4. Download **Bank portal file**

In-app: *Same as mid-month: upload sheet → generate → bank file.*

## Month-end workflow (every month)

1. Open **More → Payroll → Run** tab. Use **Full month (28→27)** — e.g. 2026-07-28 → 2026-08-27 for August 2026.
2. **Step 1 — Upload Excel** — the accountant's `.xls`/`.xlsx` (REGULAR / BAGGERS / LOADERS), e.g. `FIDO SALARY SCHEDULE AUGUST 2026.xls`.
3. **Step 2 — Generate payroll from sheet** — creates a **DRAFT** with sheet figures (`pay_source = SHEET`). The screen then opens **Saved**.
4. **Step 3 — Saved:** Approve (if needed) → **Bank portal file**.

*(Optional)* **Preview computed** from attendance. Totals do not need to match the sheet. The bank file is built from the SHEET draft, not from computed.

Prefer **Group** (or Combined Fido + Fiafia) so both workspaces' staff match the workbook.

Re-uploading the same period supersedes the previous active upload (history kept with `is_active=0`; original files are retained on disk).

## Why three nets can differ

Example (August 2026): Computed ₦6.02M vs Uploaded ₦6.93M vs SHEET draft ₦6.65M.

| Figure | Meaning | In the bank file? |
|--------|---------|-------------------|
| **Computed** | Attendance + production at Daybook rates | No (unless you Save a COMPUTED draft instead) |
| **Uploaded sheet** | Every pay row in the Excel, including people not on the roster | No — unmatched rows are dropped |
| **SHEET draft / matched** | Uploaded amounts for staff Daybook could match | **Yes** — this is what **Bank portal file** pays |

Unmatched names are listed after upload and on the Saved run. Add them under **Rates**, re-upload, then generate again so they appear in the bank file.

## File storage

Uploaded workbooks are saved on the server under `PAYROLL_SHEET_DIR` (default `backend/data/payroll-sheets/` locally, `/data/payroll-sheets` in Docker on the `daybookdata` volume). Path layout:

```
{tenant_id}/{period_from}_{period_to}/{kind}_{upload_id}.xlsx
```

Metadata on `payroll_sheet_uploads`: `stored_path`, `file_size`, `content_type`. Uploads made before this feature show **File not stored** in history.

## API

| Method | Path | Role | Notes |
|--------|------|------|-------|
| POST | `/api/payroll/sheet-upload` | SNR_ACCOUNTANT+ | Multipart `file` (.xls/.xlsx). Optional `period_from`, `period_to`, `kind`, `dry_run=1`. Response includes `sheet_summary` (matched vs unmatched) |
| GET | `/api/payroll/sheet-upload?period_from&period_to&kind` | SNR_ACCOUNTANT+ | Active upload + lines + `sheet_summary` |
| GET | `/api/payroll/sheet-upload/history` | SNR_ACCOUNTANT+ | All uploads for tenant scope (active + superseded), with linked run if any |
| GET | `/api/payroll/sheet-upload/:id/download` | SNR_ACCOUNTANT+ | Download original workbook (404 if not stored) |
| GET | `/api/payroll/sheet-upload/:id/lines` | SNR_ACCOUNTANT+ | Parsed lines for any past upload + `sheet_summary` |
| DELETE | `/api/payroll/sheet-upload/:id` | SNR_ACCOUNTANT+ | Soft-deletes (sets `is_active=0`) |
| GET | `/api/payroll/compare?period_from&period_to&kind` | SNR_ACCOUNTANT+ | Optional check: `{ computed, uploaded, diffs, sheet_summary }` — not required for the bank file |
| POST | `/api/payroll/runs2/from-sheet` | SNR_ACCOUNTANT+ | Body: `{ from, to, upload_id? }` — creates DRAFT from uploaded figures (matched staff only) |
| GET | `/api/payroll/runs2/:id` | SNR_ACCOUNTANT+ | Includes `sheet_summary` when the run was built from a sheet |
| GET | `/api/payroll/runs2/:id/bank.xlsx` | SNR_ACCOUNTANT+ | **Bank portal file** — same workbook mid-month uses. Works for SHEET and COMPUTED runs |

`POST /api/payroll/compute2` includes `sheet_upload` when an active upload exists for the same period.

## REGULAR staff pay rule (computed preview)

For **MONTHLY** (regular) staff, computed gross is:

```
gross = monthly_salary × (Mon–Sat days clocked in) / (Mon–Sat working days in period)
```

- Pay period is typically **28th previous month → 27th current month**.
- **Sundays are excluded** from both the denominator and the attendance count — the operation works Mon–Sat only.
- **27 Mon–Sat days in the period = full monthly salary** when attendance covers every working day.
- The accountant's sheet remains authoritative for month-end; use **Generate payroll from sheet** when the workbook is the source of truth.

## Workbook format

Parses sheets named **REGULAR**, **BAGGERS**, and **LOADERS** (same layout as the payroll template):

- **REGULAR**: DAYS WORKED (or DAYS ABS), NET SALARY, SALARY ADV / DEDUCTION, optional BASE SALARY
- **BAGGERS**: QTY, COMMISSION, DEDUCTION
- **LOADERS**: BAGS LOADED, NET PAY (COMMISSION), DEDUCTION

Period is read from PAY START DATE / PAY END DATE columns, or passed in the upload request.

Example (August 2026): period 2026-07-28 → 2026-08-27, **27 Mon–Sat working days**, full pay when DAYS WORKED = 27.

## Manual test plan

1. Sign in as SNR ACCOUNTANT (or GM/Admin). Prefer **Group** (Fido + Fiafia).
2. Open **More → Payroll → Run** tab. Confirm the month-end steps banner (upload → generate → bank file).
3. Set full-month dates (28→27). **Do not** require Preview computed.
4. **Upload month-end sheet** (e.g. `FIDO SALARY SCHEDULE AUGUST 2026.xls`).
5. If unmatched rows appear, note the ₦ left out of the bank file.
6. **Generate payroll from sheet** — Saved opens on the new **SHEET** draft; **Bank portal file** is the primary button.
7. Download **Bank portal file** — payees and nets match matched sheet rows (not computed, not unmatched).
8. Approve / mark paid flow unchanged.
9. Optional check vs computed still available; copy states totals do not need to match.
10. **Preview computed → Save payroll (draft)** still creates a **COMPUTED** run (unchanged). Mid-month tab unchanged.
11. Sheet-sourced drafts cannot be **Recompute**d — re-upload and generate again instead.
12. Open **Sheet history** — unmatched rows highlighted; past uploads downloadable.
13. Re-upload same period — previous upload shows **Superseded**, file still downloadable.

## Deploy notes

- Docker: files live on the existing `daybookdata` volume at `/data/payroll-sheets` (same volume as `/data/uploads`). No new volume required.
- Optional env: `PAYROLL_SHEET_DIR=/data/payroll-sheets` (default if unset).
- After deploy, `migrate()` adds `stored_path`, `file_size`, `content_type` columns automatically.

## Run provenance

| `pay_source` | Meaning |
|--------------|---------|
| `COMPUTED` | Built from attendance + production (Run tab → Preview computed → Save draft) |
| `SHEET` | Built from uploaded workbook (`runs2/from-sheet`) |

Saved runs show a **SHEET** or **COMPUTED** badge. **Bank portal file** works for both.
