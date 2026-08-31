# Payroll sheet upload (side-by-side)

SNR ACCOUNTANT+ can upload a month-end Excel workbook that is stored **independently** from computed payroll. The upload does not mutate `pay_runs`, `production`, or staff records.

## API

| Method | Path | Role | Notes |
|--------|------|------|-------|
| POST | `/api/payroll/sheet-upload` | SNR_ACCOUNTANT+ | Multipart `file` (.xls/.xlsx). Optional `period_from`, `period_to`, `kind`, `dry_run=1` |
| GET | `/api/payroll/sheet-upload?period_from&period_to&kind` | SNR_ACCOUNTANT+ | Active upload + lines for period |
| DELETE | `/api/payroll/sheet-upload/:id` | SNR_ACCOUNTANT+ | Soft-deletes (sets `is_active=0`) |
| GET | `/api/payroll/compare?period_from&period_to&kind` | SNR_ACCOUNTANT+ | `{ computed, uploaded, diffs }` |

`POST /api/payroll/compute2` now includes `sheet_upload` when an active upload exists for the same period.

## Workbook format

Parses sheets named **REGULAR**, **BAGGERS**, and **LOADERS** (same layout as the payroll template and draft import):

- **REGULAR**: DAYS WORKED, BASE SALARY, DEDUCTION, NET SALARY
- **BAGGERS**: QTY, DEDUCTION, COMMISSION
- **LOADERS**: BAGS LOADED, DEDUCTION, NET PAY (COMMISSION)

Period can be read from PAY START DATE / PAY END DATE columns, or passed in the request body.

## Manual test plan

1. Sign in as SNR ACCOUNTANT (or GM/Admin).
2. Open **More → Payroll → Run** tab.
3. Set full-month dates (28→27 preset) and **Compute** — note computed net total.
4. Use **Upload month-end sheet** with a filled workbook for the same period.
5. Confirm:
   - Upload succeeds without Admin enabling production override.
   - Card shows file name, date, line count.
   - Side-by-side banner appears with computed vs sheet totals.
   - **View diff table** shows per-staff computed net, sheet net, and delta.
6. **Save payroll (draft)** — saved run should match computed figures, not the sheet.
7. Open **Saved** tab — run shows **Sheet uploaded** badge; **Compare** opens the diff modal.
8. **Remove** the upload — badge disappears; computed preview unchanged.
9. Verify production override (Rates tab) still requires Admin enable — unchanged.

## Ambiguities / follow-ups

- Upload is anchored to the current workspace `tenant_id`; Group roll-up queries uploads across all scoped tenants.
- Re-uploading the same period supersedes the previous active upload (history kept with `is_active=0`).
- Unmatched sheet rows are stored with `staff_id` null for review but excluded from staff matching in diffs unless matched by ext ID on computed side.
