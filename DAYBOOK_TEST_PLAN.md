# Daybook — Site Test Plan (Fido parity)

**App:** https://daybook.torama.money  ·  **Test date:** _______________  ·  **Tester:** _______________  ·  **Site:** _______________  ·  **Role:** _______________

> Goal: confirm Daybook does everything Fido does, with real activity, at every site, for one full working day. Run the tests **as you work** — don't make up fake data; use your actual day's sales, expenses, cash, production and gate movements.

---

## How to use this sheet

1. Work top to bottom. Each test has **Steps** → **Expected result** → a box to mark **✅ Pass / ❌ Fail**.
2. If something fails, write what happened in **Notes** (what you tapped, what you saw). A screenshot helps a lot.
3. Some tests are role-specific — if your role can't see a feature, write **N/A**.
4. **Report issues** two ways: (a) note them on this sheet, and (b) in the app go to **More → Help/Feedback** (or send to Torama: filatei@gtsng.com). Include the time it happened.
5. The app updates itself — if asked to refresh/reload, do it.

**Roles, lowest → highest:** Gateman/Gate · Supervisor · Secretary · Site Manager · Accountant · Snr Accountant = General Manager · Admin.
Site Managers see only their own site. Snr Accountant / GM / Admin see all sites across **Fido & Fiafia**.

---

## 0. Setup & sign-in

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 0.1 | Open https://daybook.torama.money on your phone. Tap **Install / Add to Home Screen** when prompted. | App installs, opens full-screen like a normal app. | ☐ Pass ☐ Fail |
| 0.2 | Sign in with the **Google account** you were invited with. | Lands on Dashboard; top shows your **company (Fido/Fiafia)** and your **site**. | ☐ Pass ☐ Fail |
| 0.3 | Confirm your role/site is correct (ask if unsure). | You only see your site's data (managers). | ☐ Pass ☐ Fail |
| 0.4 | Press the phone **Back button** repeatedly from different screens. | App **never closes** — it steps back one screen, then to Dashboard, and stays open. | ☐ Pass ☐ Fail |

---

## 1. Dashboard

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 1.1 | Look at the Dashboard KPI cards (today / week / month). | Numbers match roughly what you expect for today. | ☐ Pass ☐ Fail |
| 1.2 | Tap **Transfer / POS**. | Splits into POS terminals & transfer banks; tap one to drill into the orders behind it. | ☐ Pass ☐ Fail |
| 1.3 | Tap **Present Today**. | Shows the list of staff currently clocked in. | ☐ Pass ☐ Fail |

---

## 2. Sell (POS) — sell water all day on Daybook

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 2.1 | Go to **Sell/Shop**. Add a product, type the **quantity**. | Quantity accepts typed numbers; total updates. | ☐ Pass ☐ Fail |
| 2.2 | Change the **unit price (rate)** on a line. | Rate is editable; total recalculates. | ☐ Pass ☐ Fail |
| 2.3 | Enter a **customer name**. Type a new name not seen before. | New customer is accepted/created on the fly; existing names suggest as you type. | ☐ Pass ☐ Fail |
| 2.4 | Pay by **Cash**. Complete the sale. | Sale records as cash; receipt appears. | ☐ Pass ☐ Fail |
| 2.5 | Pay by **Transfer** — pick the **bank** (e.g. GTB / Moniepoint-FF / Moniepoint-Fiafia). | Bank is captured and shows on the receipt + order. | ☐ Pass ☐ Fail |
| 2.6 | Pay by **POS** — pick the **terminal** (differentiate Moniepoint vs GTB). | Correct terminal captured. | ☐ Pass ☐ Fail |
| 2.7 | **Print** the receipt to your Bluetooth thermal printer. | Prints with the barcode/QR code. | ☐ Pass ☐ Fail |
| 2.8 | Create an **Incentive** order (monthly bonus, no cash collected). | It does **not** add to cash/sales totals; shows separately as incentive. | ☐ Pass ☐ Fail |
| 2.9 | Open the **Sales ticker**, find a sale, tap **Reprint**. | Receipt reprints correctly. | ☐ Pass ☐ Fail |

---

## 3. Gate & loading

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 3.1 | Supervisor: open **Gate**, scan a sale's QR/barcode (or enter receipt no.). | Order found; status **PENDING**. | ☐ Pass ☐ Fail |
| 3.2 | Mark the order **Loaded**. | Status → **LOADED**; recorded against the supervisor. | ☐ Pass ☐ Fail |
| 3.3 | Gateman: scan the same order and **Release/Exit**. | Status → **EXITED**; order leaves the gate list. | ☐ Pass ☐ Fail |
| 3.4 | Try to exit an order that wasn't loaded. | Blocked / warns appropriately. | ☐ Pass ☐ Fail |

---

## 4. Staff

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 4.1 | **Add a new staff** — choose type **regular / bagger / loader**; for regular pick a position (secretary, operator, cleaner…). | Staff saved to your site with the right type/position. | ☐ Pass ☐ Fail |
| 4.2 | **Capture the staff's passport photo**. | Photo saved; shows on their profile. | ☐ Pass ☐ Fail |
| 4.3 | **Enrol face** for clock-in. | Enrolment succeeds reasonably fast (turn-head step passes). | ☐ Pass ☐ Fail |
| 4.4 | **Delete** an enrolled face, then re-enrol. | Face removed and can be re-added. | ☐ Pass ☐ Fail |
| 4.5 | Use the **staff search** (typeahead) to find someone. | Filters as you type. | ☐ Pass ☐ Fail |
| 4.6 | **Generate / view a staff badge** (Snr Acct/GM/Admin). Print it. | Badge shows **QR code**, full-colour **Fido/Fiafia logo**, and the staff **photo** (avatar if no photo). | ☐ Pass ☐ Fail |
| 4.7 | **Scan a badge** to clock a staff **in**, later **out**. | Clock-in/out recorded; appears in Present Today. | ☐ Pass ☐ Fail |

---

## 5. Expenses

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 5.1 | Create an expense with **line items** (name, qty, rate). Type a **new vendor** and **new item**. | Vendor & item created on the fly; total = Σ line amounts. | ☐ Pass ☐ Fail |
| 5.2 | Set **Type = Imprest** on one, **Non-imprest** on another. | Type saves; Imprest chip shows on imprest tickets. | ☐ Pass ☐ Fail |
| 5.3 | Tap a ticket. | Opens a **read-only view** first (not straight to edit). | ☐ Pass ☐ Fail |
| 5.4 | Use the footer to **attach a payment receipt + note**. Attach 2+ receipts. | Receipts saved; you can **View / download** them later. | ☐ Pass ☐ Fail |
| 5.5 | **Lifecycle:** as creator/manager tap **Validate** → ticket becomes **Reviewed**. | State changes; only allowed buttons show. | ☐ Pass ☐ Fail |
| 5.6 | Admin: **Approve** (or **Decline** with a reason). | Reviewed → **Approved** / **Declined**. | ☐ Pass ☐ Fail |
| 5.7 | Manager/Accountant: **Pay**, then **Deliver**. | Approved → **Paid** → **Delivered**. | ☐ Pass ☐ Fail |
| 5.8 | Record a **part-payment** against a ticket. | amount_paid & balance update; status UNPAID/PART/PAID correct. | ☐ Pass ☐ Fail |
| 5.9 | **Filter → Imprest** in Expenses. | Shows the per-site **imprest total to transfer to Snr Accountant**. | ☐ Pass ☐ Fail |
| 5.10 | Open **Payables**, pick a vendor (e.g. Flexplast). | Shows **how much you owe** that vendor; drills to their unpaid tickets. | ☐ Pass ☐ Fail |
| 5.11 | After creating/validating an expense, check the next actioner's **Alerts** (bell) and **email**. | They receive an in-app alert + email saying what action is needed. | ☐ Pass ☐ Fail |

---

## 6. Cash at hand (end of day)

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 6.1 | Expenses → **Cash** tab → **＋**. Enter amount, depositor/agent, site, **payee account (bank)**, and snap the **transfer receipt**. Submit. | Entry saved with **NOT SEEN** status; receipt attached. | ☐ Pass ☐ Fail |
| 6.2 | Add a 2nd receipt to an existing cash entry. | Multiple receipts held against one entry. | ☐ Pass ☐ Fail |
| 6.3 | Snr Acct/GM/Admin: open an entry, tap **Mark seen**, then **Validate**. | NOT SEEN → SEEN → VALIDATED. | ☐ Pass ☐ Fail |
| 6.4 | Admin/Snr/GM: check the **reconciliation strip** at the top of Cash. | Shows **Cash collected** vs **Recorded** vs **Variance** for today (green when it balances). | ☐ Pass ☐ Fail |

---

## 7. Inventory

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 7.1 | Open **Inventory → Items**. Type-ahead an item; if new, create it on the fly. | Item created/selected; names stay unique. | ☐ Pass ☐ Fail |
| 7.2 | **Receive** stock (raw material, e.g. packing bags). Optionally tick "create payable". | On-hand increases; a payable/expense is created if ticked. | ☐ Pass ☐ Fail |
| 7.3 | **Issue / Adjust** stock. | On-hand decreases / corrects. | ☐ Pass ☐ Fail |
| 7.4 | Check **Low stock** tab. | Items at/under reorder level are listed. | ☐ Pass ☐ Fail |
| 7.5 | **Finished goods:** log production (bagged + bottle from preforms). | Per-site finished stock = produced − sold; bagged auto-counts from daily bagging. | ☐ Pass ☐ Fail |

---

## 8. Reports & daily report (the big one)

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 8.1 | Open **Reports**. | Date filters default to **today** (start + end); POS card shows "**today**". | ☐ Pass ☐ Fail |
| 8.2 | Tap **All time**, then **Today**. | Totals switch between lifetime and today. | ☐ Pass ☐ Fail |
| 8.3 | Tap **🛠 Day ops**. Enter the day's numbers: leakage, packing bags, rolls (kg), crates, water analysis (PH/TDS), generator statuses, RO readings, materials, expired docs. Save. | Saves per site/day; reopening shows your numbers. | ☐ Pass ☐ Fail |
| 8.4 | Tap **✨ Generate daily report**, pick **your site**. | Auto-fills sales (cash/POS/transfer), incentive, diesel, balance, **production day-report** (opening/production/total/sales/available bags), and shows "✓ Day operations captured". | ☐ Pass ☐ Fail |
| 8.5 | Add **incidents**, tap **Submit** (or **Email**). | Report saved/submitted; **email arrives** to you + dailyreports inbox with all sections. | ☐ Pass ☐ Fail |
| 8.6 | (GM/Snr/Admin) Generate with **🌍 All sites**. | Global roll-up: total sales, payment split, **sales distribution by site**; **Email report** works. | ☐ Pass ☐ Fail |
| 8.7 | Compare the emailed report against your usual Fido report for the same day. | Figures match (note any differences). | ☐ Pass ☐ Fail |

---

## 9. Profit & Loss / valuation (Accountant+)

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 9.1 | Open **More → Profit / P&L**. | Shows revenue − expenses; per site. | ☐ Pass ☐ Fail |
| 9.2 | Toggle **Cash ↔ Accrual**. | Numbers change basis correctly. | ☐ Pass ☐ Fail |
| 9.3 | Check **stock valuation**. | On-hand × cost totals look right. | ☐ Pass ☐ Fail |

---

## 10. Site messages, alerts & admin

| # | Steps | Expected | Result |
|---|-------|----------|--------|
| 10.1 | Post a **Site message**. | Only **you (poster)** and **Admin** can see it. You can delete your copy. | ☐ Pass ☐ Fail |
| 10.2 | Open **Activity → 🔔 Alerts**. | Your in-app notifications are listed; unread count shows; tapping opens the item. | ☐ Pass ☐ Fail |
| 10.3 | (Admin) **Members**: invite a user; press **Resend invite**. | Button spins; toast says "email sent ✓" only when truly sent; invite email arrives. | ☐ Pass ☐ Fail |
| 10.4 | (Admin) **Edit a member's** site/role. | Change saves and takes effect. | ☐ Pass ☐ Fail |
| 10.5 | (Snr Accountant) Switch between **Fido and Fiafia** and across all sites. | Can see and manage both companies / all sites. | ☐ Pass ☐ Fail |

---

## 11. Realistic full-day scenario (do this end-to-end)

Run your **whole day** on Daybook in parallel with Fido:

1. Morning: sign in, confirm opening stock in Inventory / Day ops.
2. All day: ring up **every sale** on Daybook (cash, transfer, POS, incentive) — print receipts.
3. Gate: **load and release** orders as trucks/keke leave.
4. Record **expenses** as they happen (imprest + non-imprest), attach receipts, run them through validate→approve→pay.
5. Evening: enter **cash at hand** with transfer receipts; capture **Day ops**; **Generate & submit** the daily report.
6. Compare Daybook's totals & report to Fido's for the same day → **note every difference**.

**End-of-day cross-check**

| Figure | Fido | Daybook | Match? |
|--------|------|---------|--------|
| Total sales | | | ☐ |
| Cash | | | ☐ |
| Transfer (by bank) | | | ☐ |
| POS (by terminal) | | | ☐ |
| Incentive | | | ☐ |
| Sales by site | | | ☐ |
| Production / bagging | | | ☐ |
| Expenses total | | | ☐ |

---

## Tester sign-off

Biggest problems found (top 3):
1. ______________________________________________
2. ______________________________________________
3. ______________________________________________

Overall: ☐ Ready to switch  ☐ Mostly works, small fixes  ☐ Not ready

Signature: _______________   Date: _______________
