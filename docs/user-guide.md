# User guide

LedgerLine is written for people who keep the books, not for accountants who want a
second job. This guide follows the work in the order it usually happens: set up, invoice,
get paid, pay bills, reconcile the bank, and close the month.

## 1. Set up (first 15 minutes)

Sign in and follow **Get set up** in the sidebar. The checklist tracks eight steps and
you can leave and come back at any point.

1. **Company** — name, industry, currency, fiscal-year start. The industry you pick seeds
   your chart of accounts (services, retail, wholesale, construction, restaurant,
   nonprofit, technology). You can change details later in **Settings → Company**.
2. **Chart of accounts** — review the template, rename or add accounts. Numbering follows
   the familiar 1000 assets / 2000 liabilities / 3000 equity / 4000 income /
   5000+ expenses convention.
3. **Bank account** — add the account you actually use, with its opening balance. This is
   the account your invoices get paid into by default.
4. **Customers** — add at least one, with payment terms. Terms set the default due date
   on new invoices.
5. **First invoice** — create, preview and send one.
6. **Expenses** — record a cost with or without a receipt.
7. **Reconciliation** — import a statement and match it.

If you would rather learn on sample data, an administrator can reset the training sandbox
from **Get set up**, and you can switch into training mode to see guided walkthroughs
without touching company records.

## 2. Invoices, estimates and credit memos

**Invoices & estimates** is one workspace with tabs; `?new=1` opens the composer, and the
composer is shared between invoices, estimates, credit memos and bills.

* Pick a customer (terms fill in the due date), add lines with a description, quantity,
  unit price, optional item, tax code and discount.
* **Save draft** keeps it out of the ledger. **Save and send** posts the journal entry and
  emails the customer.
* On an open invoice you can **Send reminder**, **Duplicate**, **Void**, download a
  **PDF**, copy the public payment link, or **Record payment**.
* Partial payments are fine: the invoice shows `Amount due`, `of $X total · paid $Y`, and
  a `partial` badge until the balance is zero.
* Estimates convert to invoices with one click once the customer accepts.
* Credit memos reduce what a customer owes and post the reverse entry.

**Recurring** invoices: choose frequency (weekly, monthly, quarterly, yearly), interval,
start date and template. The background worker issues them on the due date even if nobody
is logged in; pause or end a schedule from the list.

## 3. Bills and expenses

**Bills** mirror invoices on the payable side: vendor, dates, lines coded to an expense or
inventory account, optional tax. Posting a bill credits accounts payable. **Pay** records
the disbursement; **Pay scheduled** pays every bill whose scheduled date has arrived.

**Expenses** is for staff spend: upload a receipt (image or PDF), let OCR suggest the
vendor, date and total, code it to an account and submit. Approvers see a queue and can
approve or reject with a comment.

## 4. Banking and reconciliation

1. **Import statement** — paste or upload a CSV. Map the columns if the headers are not
   recognised; nothing is saved until you confirm, and duplicates are skipped on
   date + amount + description.
2. **Auto-match** — rules match statement lines to open invoices, bills and payments. A
   rule combines an amount (exact or ± tolerance), a date window, and a description
   pattern or contact. Preview a rule before switching it on.
3. **Reconcile** — start a reconciliation with the statement end date and ending balance.
   Tick off cleared lines (or use bulk **Clear all matched**), watch the difference figure
   reach zero, then **Complete**. Completed reconciliations are immutable; reopening is an
   audited action.

Unmatched lines can be turned into a payment, an expense, or a journal entry directly from
the transaction list.

## 5. Payments

**Payments** lists receipts and disbursements with method, reference and applications.
Provider checkout (card/ACH) is available when configured; otherwise record cash, cheque
or bank-transfer payments manually. Fees can be booked to a fee account, and any payment
can be voided — the ledger records the reversal rather than deleting history.

## 6. Journal, accounts and month-end close

* **Chart of accounts** — hierarchical, drag-free tree with balances, child counts and
  system-account badges. Applying an industry template adds missing accounts without
  duplicating existing ones.
* **Journal** — manual double-entry. The form refuses to save unless debits equal credits.
  Entries can be reversed (the correction pattern auditors expect) or voided.
* **Periods & close** (Settings → Periods & close) — generate monthly periods, publish
  them when the month is final, and lock. Postings dated inside a published period are
  rejected with a clear message.

Month-end routine: reconcile every bank account → review A/R and A/P aging → post
adjusting entries (accruals, depreciation, inventory) → review the trial balance → publish
and lock the period → export the statements.

## 7. Reports and dashboard

Ten reports: profit & loss, balance sheet, cash flow, trial balance, A/R aging, A/P aging,
general ledger, sales by customer, purchases by vendor, tax summary.

* Set the date range (or as-of date for the balance sheet and aging), then export CSV or
  PDF from the same screen.
* **Schedule** a report to be generated and emailed on a frequency; the worker handles it
  and delivery history is kept.
* The dashboard shows cash on hand, receivables (with the overdue slice), payables, a
  six-month income/expense trend, overdue invoices and recent activity.

## 8. Importing and exporting

**Import & export** covers the migration from another system: chart of accounts,
customers, vendors, items, invoices, bills, journal balances and bank statements. Start
with a template, run the preview to see row-level errors, then execute. See
[quickbooks-csv.md](quickbooks-csv.md) for the exact column maps. Full data export is a
set of CSV files plus a JSON bundle.

## 9. Inventory and payroll (optional modules)

Inventory tracks items and SKUs, receives stock when an inventory-coded bill is posted,
computes weighted-average cost and COGS, and supports manual adjustments with a reason.
Valuation and movement history are on the same page.

Payroll is behind a feature flag: employees, timesheets (submit and approve), payroll runs
with progressive bands and statutory lines, approval, payment posting and payslip PDFs.
Enable it in **Settings → Features** — payroll is off by default.

## 10. Keyboard and accessibility

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ K` | Command palette (new invoice, new bill, jump to a page) |
| `g` then `d` | Dashboard |
| `g` then `i` | Invoices |
| `g` then `b` | Bills |
| `g` then `c` | Customers |
| `g` then `r` | Reports |
| `g` then `a` | Chart of accounts |
| `g` then `j` | Journal |
| `g` then `k` | Banking |
| `g` then `s` | Settings |
| `/` | Focus the page search box |
| `?` | Shortcut cheat-sheet |
| `Esc` | Close a dialog or the palette |

The interface targets WCAG 2.1 AA: keyboard-reachable controls, a skip link to `#main`,
landmarks, visible focus rings, labelled form fields, `aria-live` toasts and status text,
and no colour-only meaning. Tables expose captions and scope headers.

## 11. Getting help

Inline hints explain tricky fields (money format, tax codes, statement mapping). The
onboarding checklist links to the relevant page for every step. If something looks wrong,
**Settings → Audit** shows every change with who made it and when, and an administrator
can verify the audit chain before escalating.
