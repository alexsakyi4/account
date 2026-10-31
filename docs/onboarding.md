# Onboarding and training content

Three things help a new company get productive quickly: a tracked setup checklist, a
sandbox to practise in, and short walkthroughs anchored to real screens.

## Setup checklist (8 steps)

The API stores progress in `onboarding_progress`, so it is per company and survives
sessions. `GET /onboarding` returns each step with a completion timestamp and a
`completed` count; `POST /onboarding/:step` marks a step done; `POST /onboarding/reset`
clears it (requires `company:manage`).

| Key | Title | What "done" means | Where it happens |
| --- | --- | --- | --- |
| `company` | Confirm your company details | Name, industry, currency and fiscal year saved | Settings → Company |
| `accounts` | Review your chart of accounts | Template applied and reviewed | Chart of accounts |
| `bank` | Connect or add a bank account | At least one bank account with an opening balance | Banking |
| `customers` | Add your first customer | At least one customer with terms | Customers |
| `invoice` | Create and send an invoice | An invoice created (draft is fine) | Invoices |
| `expenses` | Record a bill or expense | A bill or expense recorded | Bills / Expenses |
| `reconcile` | Reconcile your bank account | A statement imported and a reconciliation started | Banking |
| `reports` | Run your first report | A report opened with a date range | Reports |

The sidebar shows progress until every step is complete; the checklist stays available
afterwards for refreshers.

## Training mode

The **Get set up** page carries the training-mode toggle (Settings → Company has the
company profile itself). The web app keeps the choice in `localStorage` under
`ledgerline.trainingMode`, and the demo seed creates
*Lakeside Trading Co.* as a sandbox tenant (`is_sandbox = 1`). Sandbox tenants are labelled
throughout the UI so nobody mistakes test data for the real books.

What to practise in the sandbox, in order:

1. **Issue an invoice and take a partial payment.** Watch `Amount due` move and the status
   become `partial`, then open **Journal** and find the two entries.
2. **Enter a bill and pay it.** Note that the payable disappears from A/P aging only after
   the payment is applied, not when the bill is created.
3. **Import the sample bank statement** in **Banking**, run **Auto-match**, and reconcile to
   a zero difference. Deliberately leave one line unmatched to see the difference warning.
4. **Post a correcting entry.** Void an invoice and inspect the reversal in the journal.
5. **Run the month-end close.** Generate the period, publish it, then try to post a
   journal entry dated inside it — the API refuses with a clear message.
6. **Export reports.** P&L and A/R aging as CSV and PDF.

## Walkthroughs

Four guided tours are available from **Get set up**. Each is a sequence of short steps with
a link to the exact screen, so a bookkeeper can follow along without a trainer.

| Walkthrough | Steps | Audience |
| --- | --- | --- |
| Invoicing to cash | Create invoice → send → record payment → check aging | Bookkeeper, sales admin |
| Bills to payment | Enter bill → schedule → pay → check A/P aging | Bookkeeper |
| Bank reconciliation | Import → rule → auto-match → reconcile → complete | Bookkeeper, accountant |
| Month-end close | Adjusting entry → trial balance → lock the period | Accountant |

## Sample data

`npm run db:seed` creates a platform administrator, the demo administrator, and a sandbox
company with a retail chart of accounts, customers and vendors, invoices in several states
(open, partial, paid, overdue), bills, bank transactions and an open reconciliation. The
seed is idempotent: running it twice will not duplicate the company.

For a clean tenant, register a new company — it gets its own chart of accounts from the
industry template, an empty ledger and a fresh checklist.

## Suggested rollout for a real company

* **Week 1** — administrator sets company, users and roles; accountant reviews the chart of
  accounts and tax codes; import customers, vendors and the opening trial balance as a
  single journal entry dated the day before go-live.
* **Week 2** — bookkeeper works in parallel with the old system for one week; compare
  trial balances at the end.
* **Week 3** — cut over invoicing and bills; connect or import bank statements daily.
* **Month 1 close** — run the close routine in LedgerLine, keep the old system read-only,
  then archive it.

Handy checks during rollout: A/R aging matches the old system, bank reconciliation
difference is zero, and the audit log shows only expected actors.
