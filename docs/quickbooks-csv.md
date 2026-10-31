# Migrating from QuickBooks-style CSV exports

LedgerLine does not embed, copy or require QuickBooks. It reads **CSV exports with the
same column names** that mainstream small-business accounting tools produce, so a file
exported from your current system can be loaded without hand-editing headers. Everything
below is LedgerLine's own template and mapping logic (`server/src/modules/imports.ts`).

## Workflow

```bash
# 1. See the supported kinds and their exact columns
curl -s localhost:4000/api/v1/imports/templates -H "authorization: Bearer $TOKEN"

# 2. Download a blank-ish template (one sample row per kind)
curl -sO localhost:4000/api/v1/imports/templates/customers.csv -H "authorization: Bearer $TOKEN"

# 3. Dry-run: headers are auto-mapped, nothing is written
curl -sX POST localhost:4000/api/v1/imports/preview -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"customers","csv":"<file contents>"}'

# 4. Execute once the preview is clean
curl -sX POST localhost:4000/api/v1/imports/execute -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"customers","csv":"<file contents>","filename":"customers.csv"}'
```

In the app: **Import & export** → pick a kind → download template → drop the CSV →
**Preview** → fix the listed rows → **Import**. Preview reports per-row problems without
touching data; execute records an `import_jobs` row so you can review history.

## Column mapping

Headers are normalised (lower-case, non-alphanumerics removed) and matched against a
candidate list per field, first exactly and then by substring. That means
`Customer`, `Customer Name`, `customer_name` and `CUSTOMER` all resolve to the same field,
and `Item(Product/Service)` matches `itemproductservice`. You can override any field with
an explicit `mapping` object (`{"name": "My Column Header"}`).

### Chart of accounts — `accounts`

| Template column | Required | Notes |
| --- | --- | --- |
| `Account Number` | recommended | Used as the code; duplicates are skipped |
| `Account Name` | yes | |
| `Type` | yes | Bank, Other Current Asset, Fixed Asset, Accounts Receivable, Inventory, Accounts Payable, Credit Card, Equity, Income, Cost of Goods Sold, Expense, Other Expense — normalised to the LedgerLine type |
| `Detail Type` | no | Stored as a subtype, e.g. `Checking`, `Service/Fee Income` |
| `Description` | no | |
| `Balance` | no | Opening balance; posted only if non-zero |

### Customers — `customers`

`Customer`, `Company Name`, `Email`, `Phone`, `Billing Address Line 1`,
`Billing Address City`, `Billing Address Postal Code`, `Billing Address Country`,
`Terms`, `Credit Limit`, `Currency`, `Notes`.

`Terms` accepts `Net 30`, `30`, `Net 15`, `Due on receipt` — the first number is used, and
a missing value defaults to 30 days. `Credit Limit` is a decimal amount.

### Vendors — `vendors`

Same addresses minus the postal code: `Vendor`, `Company Name`, `Email`, `Phone`,
`Billing Address Line 1`, `Billing Address City`, `Billing Address Country`, `Terms`,
`Currency`, `Notes`.

### Products & services — `items`

`Item Name`, `SKU`, `Type` (Inventory / Service / Non-inventory), `Sales Price`,
`Purchase Cost`, `Quantity On Hand`, `Description`. Items with a quantity create an
opening stock movement; keep quantities out unless you are also importing the
corresponding opening balance.

### Invoices — `invoices`

`Invoice Number`, `Customer`, `Invoice Date`, `Due Date`, `Item(Product/Service)`,
`Item Quantity`, `Item Rate`, `Item Description`, `Tax Name`, `Currency`, `Memo`.

Rows sharing an invoice number are grouped into one invoice with several lines. The
customer must already exist (import customers first) and `Tax Name` must match a tax code
you have created in Settings → Taxes.

Imported invoices arrive as **drafts** so you can review the line mapping before anything
reaches the ledger; open each one and use **Post** (`POST /invoices/:id/post`) when it
looks right. Bills and journals are posted during the import (bills as `open`, journals as
an opening entry), because they are usually the receivables/payables you are migrating.

### Bills — `bills`

`Bill Number`, `Vendor`, `Bill Date`, `Due Date`, `Account`, `Line Amount`,
`Description`, `Tax Amount`. `Account` is a code or exact name; a missing account fails
that bill only. Rows sharing a bill number are grouped.

### Journal entries — `journal`

`Journal Number`, `Journal Date`, `Account`, `Debit`, `Credit`, `Description`, `Name`.
Rows are grouped by journal number and posted as one balanced entry. Use this for the
opening trial balance: one journal per account or one journal with all lines, as long as
debits equal credits. Accounts must exist by code or name.

### Bank statement — `bank`

`Date`, `Description`, `Amount` (negative for money out). Pick the target bank account in
the import dialog. Duplicate lines (same date, amount and description) are skipped, so
importing an overlapping statement is safe.

## Practical migration order

1. **Chart of accounts** — first, because every other kind references it.
2. **Customers** and **Vendors**.
3. **Products & services** (skip if you are not using inventory).
4. **Opening journal** — dated the day before your go-live, so the trial balance matches
   the old system.
5. **Open invoices and bills** — only those still outstanding; don't import history that
   is already summarised in the opening balance.
6. **Bank statement** — your current month, then reconcile.

## Validation rules and common errors

| Message | Cause | Fix |
| --- | --- | --- |
| `Customer "X" not found` | Invoice imported before the customer | Import customers first, or correct the name |
| `Vendor "X" not found` | Bill imported before the vendor | Import vendors first |
| `Account "6500" not found` | Account code missing or renamed | Import the chart of accounts, or use the exact name |
| `Journal entry is out of balance: debits … vs credits …` | Opening journal rows are unbalanced | Adjust the rows or add an offsetting line |
| `The file has no data rows` | Only headers, or a blank line at the top | Re-export with the header on line 1 |
| `Row N: invalid date` | Locale date like `05/01/2024` | Use `YYYY-MM-DD` (most exports already do) |

## Known limits

* Amounts are parsed as decimal strings; currency symbols and thousands separators are
  stripped, but mixed currencies inside one import file are not supported.
* Journal imports post in the company currency (USD in the demo) — multi-currency opening
  balances need one import per currency with exchange rates applied first.
* Source IDs from the old system are not preserved; the invoice/bill number is kept, which
  is what reconciliations and audits reference.
* Attachments (receipts, original PDFs) are not part of a CSV export; upload them through
  the expense or bill record afterwards.
* Automatic column detection is substring based. If your export has two similarly named
  columns, supply an explicit `mapping` so the right one wins.
