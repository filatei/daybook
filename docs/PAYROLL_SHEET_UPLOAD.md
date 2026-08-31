# Payroll sheet upload & month-end workflow

SNR ACCOUNTANT+ can upload a month-end Excel workbook and use it as the **authoritative** payroll source. The upload is also stored for side-by-side comparison with computed figures.

## Month-end workflow (every month)

1. Open **More → Payroll → Run** tab.
2. Set dates with **Full month (28→27)** — e.g. 2026-07-28 → 2026-08-27 for August 2026.
3. *(Optional)* **Compute** to preview attendance-based figures and compare.
4. **Upload month-end sheet** — choose the accountant's `.xls`/`.xlsx` (REGULAR / BAGGERS / LOADERS).
5. **Generate payroll from sheet** — creates a **DRAFT** run with sheet figures (`pay_source = SHEET`).
6. Open **Saved** tab → approve → mark paid → **Bank file** download.

Re-uploading the same period supersedes the previous active upload (history kept with `is_active=0`).

## REGULAR staff pay rule (computed preview)

For **MONTHLY** (regular) staff, computed gross is:

```
gross = monthly_salary × (Mon–Sat days clocked in) / (Mon–Sat working days in period)
```

- Pay period is typically **28th previous month → 27th current month**.
- **Sundays are excluded** from both the denominator and the attendance count — the operation works Mon–Sat only.
- **27 Mon–Sat days in the period = full monthly salary** when attendance covers every working day.
- The accountant's sheet remains authoritative for month-end; use **Generate payroll from sheet** when the workbook is the source of truth.

## API

| Method | Path | Role | Notes |
|--------|------|------|-------|
| POST | `/api/payroll/sheet-upload` | SNR_ACCOUNTANT+ | Multipart `file` (.xls/.xlsx). Optional `period_from`, `period_to`, `kind`, `dry_run=1` |
| GET | `/api/payroll/sheet-upload?period_from&period_to&kind` | SNR_ACCOUNTANT+ | Active upload + lines for period |
| DELETE | `/api/payroll/sheet-upload/:id` | SNR_ACCOUNTANT+ | Soft-deletes (sets `is_active=0`) |
| GET | `/api/payroll/compare?period_from&period_to&kind` | SNR_ACCOUNTANT+ | `{ computed, uploaded, diffs }` |
| POST | `/api/payroll/runs2/from-sheet` | SNR_ACCOUNTANT+ | Body: `{ from, to, upload_id? }` — creates DRAFT from active upload |
| GET | `/api/payroll/runs2/:id/bank.xlsx` | SNR_ACCOUNTANT+ | Bank payment workbook (works for SHEET and COMPUTED runs) |

`POST /api/payroll/compute2` includes `sheet_upload` when an active upload exists for the same period.

## Workbook format

Parses sheets named **REGULAR**, **BAGGERS**, and **LOADERS** (same layout as the payroll template):

- **REGULAR**: DAYS WORKED (or DAYS ABS), NET SALARY, SALARY ADV / DEDUCTION, optional BASE SALARY
- **BAGGERS**: QTY, COMMISSION, DEDUCTION
- **LOADERS**: BAGS LOADED, NET PAY (COMMISSION), DEDUCTION

Period is read from PAY START DATE / PAY END DATE columns, or passed in the upload request.

Example (August 2026): period 2026-07-28 → 2026-08-27, **27 Mon–Sat working days**, full pay when DAYS WORKED = 27.

## Manual test plan

1. Sign in as SNR ACCOUNTANT (or GM/Admin).
2. Open **More → Payroll → Run** tab.
3. Set full-month dates (28→27) and **Compute** — note computed net total for regular staff.
4. **Upload month-end sheet** (e.g. `FIDO SALARY SCHEDULE AUGUST 2026.xls`).
5. Confirm side-by-side comparison shows computed vs sheet totals.
6. **Generate payroll from sheet** — confirm draft appears on **Saved** with **SHEET** badge.
7. **Bank file** download from Saved — verify payees and net amounts match the sheet.
8. Approve / mark paid flow unchanged.
9. **Save payroll (draft)** from Compute still creates a **COMPUTED** run (unchanged).
10. Sheet-sourced drafts cannot be **Recompute**d — re-upload and generate again instead.

## Run provenance

| `pay_source` | Meaning |
|--------------|---------|
| `COMPUTED` | Built from attendance + production (Run tab → Save draft) |
| `SHEET` | Built from uploaded workbook (`runs2/from-sheet`) |

Saved runs show a **SHEET** or **COMPUTED** badge. Bank export works for both.
