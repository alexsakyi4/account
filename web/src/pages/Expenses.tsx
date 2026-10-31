import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney, titleCase, today, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from '../components/ui';

interface ExpenseRow {
  id: string;
  number: string;
  date: string;
  status: string;
  currency: string;
  total: number;
  employee_id: string | null;
  contact_name: string | null;
  memo: string | null;
  receipt_attachment_id: string | null;
  journal_entry_id: string | null;
  ocr_json: string | null;
}

interface ExpenseDetail {
  expense: ExpenseRow;
  lines: Array<{ id: string; description: string; amount: number; account_code?: string | null; account_name?: string | null; tax_amount?: number }>;
}

interface OcrResult {
  merchant?: string | null;
  total?: number | null;
  date?: string | null;
  tax?: number | null;
  confidence?: number;
}

export function ExpensesPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(params.get('new') === '1');
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ status: status === 'all' ? undefined : status, pageSize: 50 }), [status]);
  const { data, loading, error, reload } = useQuery<{ data: ExpenseRow[] }>('/expenses', query);
  const { data: detail, reload: reloadDetail } = useQuery<ExpenseDetail>(detailId ? `/expenses/${detailId}` : null);
  const rows = data?.data ?? [];

  const act = async (expense: ExpenseRow, action: 'approve' | 'reject' | 'post') => {
    setBusy(true);
    try {
      await api.post(`/expenses/${expense.id}/${action}`, {});
      toast.success({ approve: 'Expense approved', reject: 'Expense rejected', post: 'Expense posted' }[action]);
      reload();
      if (detailId === expense.id) reloadDetail();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Capture receipts, submit expenses and reimburse employees or vendors."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setFormOpen(true);
              const next = new URLSearchParams(params);
              next.delete('new');
              setParams(next, { replace: true });
            }}
          >
            + New expense
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">All expenses</h2>
          <div className="flex items-center gap-2">
            <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status" className="w-40 py-1.5 text-xs">
              {['all', 'draft', 'submitted', 'approved', 'posted', 'rejected'].map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {loading && !data ? (
          <TableSkeleton rows={5} columns={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No expenses yet"
            description="Snap a receipt or enter an expense manually — OCR fills in the merchant, date and total."
            action={<Button variant="primary" onClick={() => setFormOpen(true)}>Record an expense</Button>}
          />
        ) : (
          <Table caption="Expenses">
            <THead>
              <tr>
                <TH>Number</TH>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH>Status</TH>
                <TH numeric>Amount</TH>
                <TH>Receipt</TH>
                <TH>Actions</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <button className="font-medium text-ink-900 hover:underline" onClick={() => setDetailId(row.id)}>
                      {row.number}
                    </button>
                  </TD>
                  <TD>{formatDate(row.date, 'short')}</TD>
                  <TD className="max-w-64 truncate">{row.memo ?? row.contact_name ?? 'Expense'}</TD>
                  <TD>
                    <StatusBadge status={row.status} />
                  </TD>
                  <TD numeric>
                    <Money amount={row.total} currency={row.currency} />
                  </TD>
                  <TD>{row.receipt_attachment_id ? 'Attached' : '—'}</TD>
                  <TD>
                    <div className="flex gap-1">
                      {row.status === 'submitted' && can('timesheets:approve') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void act(row, 'approve')}>
                            Approve
                          </Button>
                          <Button size="sm" variant="ghost" className="text-red-700" onClick={() => void act(row, 'reject')}>
                            Reject
                          </Button>
                        </>
                      )}
                      {row.status === 'approved' && can('accounts:write') && (
                        <Button size="sm" variant="ghost" onClick={() => void act(row, 'post')}>
                          Post to ledger
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ExpenseForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        currency={currency}
        onSaved={() => {
          reload();
          setFormOpen(false);
        }}
      />

      <Modal
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
        title={detail?.expense.number ?? 'Expense'}
        description={detail ? `${formatDate(detail.expense.date)} · ${formatMoney(detail.expense.total, detail.expense.currency)}` : undefined}
        footer={
          detail && (
            <>
              {detail.expense.status === 'submitted' && can('timesheets:approve') && (
                <Button variant="primary" loading={busy} onClick={() => void act(detail.expense, 'approve')}>
                  Approve
                </Button>
              )}
              {detail.expense.status === 'approved' && (
                <Button variant="primary" loading={busy} onClick={() => void act(detail.expense, 'post')}>
                  Post to ledger
                </Button>
              )}
            </>
          )
        }
      >
        {!detail ? (
          <TableSkeleton rows={4} columns={2} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge status={detail.expense.status} />
              {detail.expense.journal_entry_id && <span className="text-xs text-brand-800">Posted to journal</span>}
            </div>
            <Table caption="Expense lines">
              <THead>
                <tr>
                  <TH>Description</TH>
                  <TH>Account</TH>
                  <TH numeric>Amount</TH>
                </tr>
              </THead>
              <tbody>
                {detail.lines.map((line) => (
                  <TR key={line.id}>
                    <TD>{line.description}</TD>
                    <TD className="text-xs text-ink-500">
                      {line.account_code} {line.account_name}
                    </TD>
                    <TD numeric>{formatMoney(line.amount + (line.tax_amount ?? 0), detail.expense.currency)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            {detail.expense.memo && <p className="text-sm text-ink-600">{detail.expense.memo}</p>}
            {detail.expense.receipt_attachment_id && (
              <a
                className="text-sm font-semibold text-brand-800 underline"
                href={`/api/v1/attachments/${detail.expense.receipt_attachment_id}`}
                target="_blank"
                rel="noreferrer"
              >
                View receipt
              </a>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function ExpenseForm({
  open,
  onClose,
  currency,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
  onSaved: () => void;
}): React.JSX.Element {
  const { data: accountData } = useQuery<{ data: Array<{ id: string; code: string; name: string; type: string }> }>(open ? '/accounts?pageSize=300' : null);
  const { data: taxData } = useQuery<{ data: Array<{ id: string; code: string; rate_bp: number; is_active?: number }> }>(open ? '/tax-codes' : null);
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [memo, setMemo] = useState('');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const accounts = (accountData?.data ?? []).filter((account) => account.type === 'expense');
  const effectiveAccount = accountId || accounts[0]?.id || '';
  const taxCode = (taxData?.data ?? []).find((code) => code.id === taxCodeId);
  const subtotal = toMinor(amount);
  const tax = taxCode ? Math.round((subtotal * taxCode.rate_bp) / 10_000) : 0;

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('entityType', 'expense');
      const result = await api.post<{ id: string; ocr: OcrResult }>('/attachments', form);
      setReceiptId(result.id);
      setOcr(result.ocr);
      if (result.ocr?.merchant) setDescription(result.ocr.merchant);
      if (result.ocr?.total) setAmount((result.ocr.total / 100).toFixed(2));
      if (result.ocr?.date) setDate(result.ocr.date);
      toast.success('Receipt scanned', 'Check the extracted fields before saving.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!effectiveAccount) {
      setError('Choose an expense account.');
      return;
    }
    if (subtotal <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/expenses', {
        date,
        currency,
        memo: memo || description || undefined,
        status: 'submitted',
        receiptAttachmentId: receiptId ?? undefined,
        ocr: ocr ?? undefined,
        lines: [
          {
            description: description || 'Expense',
            amount: subtotal,
            accountId: effectiveAccount,
            taxCodeId: taxCodeId || null,
          },
        ],
      });
      toast.success('Expense submitted', 'An approver can review it now.');
      setDescription('');
      setAmount('');
      setMemo('');
      setReceiptId(null);
      setOcr(null);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New expense"
      description="Attach a receipt to prefill the merchant, date and total."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            Submit expense
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border-2 border-dashed border-ink-200 bg-ink-50 p-4 text-center">
          <p className="text-sm font-medium text-ink-700">Receipt capture</p>
          <p className="mt-1 text-xs text-ink-500">PNG, JPG, WebP or PDF up to 10 MB. Text is extracted locally, then reviewed by you.</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button className="mt-3" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
            {receiptId ? 'Replace receipt' : 'Upload receipt'}
          </Button>
          {ocr && (
            <dl className="mx-auto mt-3 grid max-w-sm grid-cols-2 gap-2 text-left text-xs">
              <div>
                <dt className="text-ink-500">Merchant</dt>
                <dd className="font-medium text-ink-800">{ocr.merchant ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-500">Total</dt>
                <dd className="font-medium text-ink-800">{ocr.total ? formatMoney(ocr.total, currency) : '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-500">Date</dt>
                <dd className="font-medium text-ink-800">{ocr.date ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-500">Tax</dt>
                <dd className="font-medium text-ink-800">{ocr.tax ? formatMoney(ocr.tax, currency) : '—'}</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" htmlFor="exp-date">
            <Input id="exp-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Amount" htmlFor="exp-amount">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-ink-400">{currency}</span>
              <input
                id="exp-amount"
                inputMode="decimal"
                className="input pl-12 text-right tabular-nums"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
            </div>
          </Field>
          <Field label="Description" htmlFor="exp-desc">
            <Input id="exp-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Taxi to client site" />
          </Field>
          <Field label="Category" htmlFor="exp-account">
            <Select id="exp-account" value={effectiveAccount} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tax code" htmlFor="exp-tax">
            <Select id="exp-tax" value={taxCodeId} onChange={(event) => setTaxCodeId(event.target.value)}>
              <option value="">No tax</option>
              {(taxData?.data ?? [])
                .filter((code) => code.is_active !== 0)
                .map((code) => (
                  <option key={code.id} value={code.id}>
                    {code.code} ({(code.rate_bp / 100).toFixed(0)}%)
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Note" htmlFor="exp-memo">
            <Textarea id="exp-memo" value={memo} onChange={(event) => setMemo(event.target.value)} className="min-h-9" />
          </Field>
        </div>

        <dl className="flex justify-end gap-6 rounded-lg bg-ink-50 px-4 py-2 text-sm">
          <div className="text-ink-600">
            Subtotal <span className="ml-1 font-medium text-ink-900">{formatMoney(subtotal, currency)}</span>
          </div>
          <div className="text-ink-600">
            Tax <span className="ml-1 font-medium text-ink-900">{formatMoney(tax, currency)}</span>
          </div>
          <div className="font-semibold text-ink-900">Total {formatMoney(subtotal + tax, currency)}</div>
        </dl>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
