# Daybook — Accounting, Tax & Regulatory Compliance Strategy

_Status: v1 (2026-07). Applies to Fido Water, Fiafia Water and future tenants (water & food manufacturing/retail in Nigeria)._

## 1. Objective

Let Daybook quietly accumulate the numbers a business already records — **sales, expenses, inventory, payroll** — and, in a few clicks, produce:

1. A **year-end Account Statement** (management-accounts / income statement + supporting schedules) that can be **filed with the Nigeria Revenue Service (NRS, formerly FIRS)** or **handed to an external auditor** to finalise.
2. A **regulatory documents vault** where every licence, permit, filing receipt and letter **to and from regulators** is stored and retrievable.

This is an internal, finance-only capability — it is **not shown to ordinary users**. Only **Snr Accountant, General Manager and Admin** see it.

> Daybook is not a substitute for a chartered accountant. It produces an accurate, auditable **starting point** from primary records; a qualified accountant/auditor finalises statutory accounts and files them.

## 2. Nigerian tax context (as at 2026)

The **Nigeria Tax Act 2025** and **Nigeria Tax Administration Act 2025** (signed 26 June 2025, main provisions effective **1 January 2026**) reshaped the landscape:

- **FIRS → Nigeria Revenue Service (NRS)** — the single federal collector of tax and non-tax revenue.
- **Small-company exemption** — a company with **annual turnover ≤ ₦100 million** *and* **total fixed assets ≤ ₦250 million** is **exempt from Companies Income Tax (CIT), Capital Gains Tax and the new Development Levy** (professional-services firms excluded). Fido/Fiafia are very likely small companies today → **CIT-exempt**, but the exemption must be *claimed with a return and proper accounts*, not assumed.
- **VAT** — potable water and basic/unprocessed food are **VAT-exempt/zero-rated**, so a pure water/sachet business typically charges no VAT. It still cannot recover input VAT and must watch any non-exempt product lines.

Obligations that remain even when CIT-exempt:

| Obligation | Basis | Cadence | Notes |
|---|---|---|---|
| **PAYE** | Employee income tax | Monthly, by 10th | Remit to the **State IRS** where staff reside |
| **Pension** | 8% employee + 10% employer of emoluments | Monthly | Mandatory ≥ 3 employees |
| **NSITF (Employee Compensation)** | **1% of total payroll** | Monthly, before 16th | **Employer cost — never deducted from staff**; 10% penalty if late |
| **ITF (Industrial Training Fund)** | **1% of annual payroll** | Annually by 1 April | Employers with ≥ 5 staff or ≥ ₦50m turnover |
| **CIT / Development Levy return** | Annual return | Annually | File even if exempt, to claim small-company status |
| **WHT** | On some vendor payments | On payment | Track deductions to remit |
| **NAFDAC** | Product registration & facility | Renewal cycle | Water/food licensing |
| **SON / product cert** | Standards | Per certificate | |
| **State environmental / effluent permit** | State EPA | Annual | |
| **Waste management** | State/LGA | Periodic | |
| **Local council (LGA)** | Signage, tenement, operating permit | Annual | |

_Sources: PwC, EY, KPMG, Baker Tilly analyses of the Nigeria Tax Act 2025; NSITF; ITF._

## 3. What Daybook already captures (and the gaps)

**Captured:** POS sales (`pos_sales`, per site, per product, incentive-flagged), expenses (`expenses`, category + vendor + imprest/non-imprest + payment workflow), cash deposits, day-ops production & stock (bags, rolls, crates, opening stock `fg_opening`), payroll runs (`pay_runs`/`pay_run_lines`, gross/deductions/net), generators (asset cost), compliance documents (`compliance_docs`).

**Gap:** Daybook is a **records system, not a double-entry general ledger**. So the year-end output is an **income-statement-first management account** with schedules, from which an accountant derives statutory financial statements (balance sheet, notes). This is honest, auditable, and enough to file a small-company return or brief an auditor. A future phase adds a proper GL.

## 4. The year-end Account Statement (design)

`GET /api/accounts/year-statement.xlsx?year=YYYY` (Snr Accountant+). One workbook:

- **Cover** — company, financial year, basis of preparation, small-company/exemption note, "prepared from Daybook records — subject to audit adjustment".
- **Income Statement** — Revenue (net of incentive/free goods) − Cost of sales (opening stock + production inputs − closing stock, approximated from consumable expense categories) = Gross profit; less Operating expenses by category; less Staff costs; less Depreciation (straight-line on generators/assets); = **Net profit before tax**.
- **Revenue** — by month and by product.
- **Expenses** — by category, imprest vs non-imprest, with totals.
- **Payroll & statutory** — total gross payroll for the year, plus computed **NSITF (1%)**, **ITF (1%)**, employer **pension (10%)** memos.
- **Tax computation (memo)** — turnover vs ₦100m and assets vs ₦250m thresholds → small-company **CIT/CGT/Development-Levy exemption** flag; otherwise indicative CIT and Development Levy lines — clearly marked *"indicative — confirm with tax adviser"*.

Every figure ties back to a Daybook query, so an auditor can trace it.

## 5. Regulatory documents vault

Daybook's existing **Compliance** module (`compliance_docs`) is the vault. It stores licences/permits/certificates/**letters** with issuer (NAFDAC, SON, State Govt, LGA…), reference no., issue/expiry dates, the actual file, and it already sends **expiry reminders** (30/14/7-day + expired). Extension in this release:

- A **direction** field — **INBOUND** (received from a regulator) vs **OUTBOUND** (filed/sent to a regulator) — so the section is a true *"documents in and out to/from regulators"* log.
- Document types broadened to cover **TAX_FILING, NSITF, ITF, PENSION, PAYE, NAFDAC, SON, ENVIRONMENTAL, WASTE, LGA/COUNCIL, LETTER, OTHER**.
- Visible to **Snr Accountant / GM / Admin** (and the site managers who hold site licences).

## 6. Roadmap

- **Phase 1 (this release):** year-end Account Statement export; regulator-docs vault with in/out direction; statutory (NSITF/ITF/pension) memos.
- **Phase 2:** double-entry GL + trial balance; WHT & VAT tracking; a statutory-obligations checklist with auto due-date reminders (PAYE 10th, NSITF 16th, ITF 1 Apr, annual return); depreciation register.
- **Phase 3:** direct NRS/TaxProMax and state-IRS e-filing hooks; auditor read-only export pack (statements + supporting schedules + document vault index).

## 7. Guardrails

- Finance-only: hidden from ordinary users; enforced server-side (Snr Accountant+).
- Outputs are labelled **management accounts, subject to audit** — Daybook computes, a professional certifies and files.
