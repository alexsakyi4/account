import { useMemo, useState } from 'react';
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
  Pagination,
  Select,
  StatCard,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface PaymentRow {
  id: string;
  number: string;
  direction: string;
  contact_name: string | null;
  date: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  reference: string | null;
  provider: string;
  provider_fee: number;
  application_count: number;
}

interface InvoiceOption {
  id: string;
  number: string;
  contact_id: string;
  contact_name: string;
  balance: number;
  status: string;
}

export function PaymentsPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [direction, setDirection] = useState('all');
  const [page, setPage] = useState(1);
  const [newOpen, setNewOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PaymentRow | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ direction, page, pageSize: 25 }), [direction, page]);
  const { data, loading, error, reload } = useQuery<{ data: PaymentRow[]; pagination?: { total: number } }>('/payments', query);
  const { data: summary, reload: reloadSummary } = useQuery<{ received: number; disbursed: number; fees: number }>('/payments/summary');
  const { data: providers } = useQuery<{ card: { provider: string; configured: boolean; description: string }; ach: { configured: boolean } }>('/payments/providers');

  const rows = data?.data ?? [];

  const voidPayment = async () => {
    if (!voidTarget) return;
    setBusy(true);
    try {
      await api.post(`/payments/${voidTarget.id}/void`, {});
      toast.success('Payment voided', 'The ledger impact was reversed.');
      setVoidTarget(null);
      reload();
      reloadSummary();
    } catch (err) {
      toast.error('Could not void payment', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Payments"
        description="Money in and money out, with provider references and fees."
        actions={
          can('payments:write') ? (
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              + Record payment
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Received" value={<Money amount={summary?.received ?? 0} currency={currency} />} hint="All time" tone="positive" />
        <StatCard label="Paid out" value={<Money amount={summary?.disbursed ?? 0} currency={currency} />} hint="All time" />
        <StatCard label="Provider fees" value={<Money amount={summary?.fees ?? 0} currency={currency} />} hint="Card and ACH processing" />
        <StatCard
          label="Card processing"
          value={providers?.card.configured ? 'Stripe connected' : 'Sandbox'}
          hint={providers?.card.configured ? 'PCI scope minimised' : 'Add STRIPE_SECRET_KEY to go live'}
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">Payment history</h2>
          <Select value={direction} onChange={(event) => (setDirection(event.target.value), setPage(1))} aria-label="Payment direction" className="w-44 py-1.5 text-xs">
            <option value="all">All payments</option>
            <option value="receipt">Received</option>
            <option value="disbursement">Paid out</option>
          </Select>
        </div>
        {loading && !data ? (
          <TableSkeleton rows={5} columns={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState title="No payments yet" description="Record a payment against an invoice or bill to see it here." />
        ) : (
          <>
            <Table caption="Payments">
              <THead>
                <tr>
                  <TH>Number</TH>
                  <TH>Date</TH>
                  <TH>Contact</TH>
                  <TH>Method</TH>
                  <TH>Status</TH>
                  <TH numeric>Amount</TH>
                  <TH>Actions</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD className="tabular-nums">{row.number}</TD>
                    <TD>{formatDate(row.date, 'short')}</TD>
                    <TD>{row.contact_name ?? '—'}</TD>
                    <TD>
                      {titleCase(row.method)}
                      {row.reference && <p className="text-xs text-ink-500">{row.reference}</p>}
                    </TD>
                    <TD>
                      <StatusBadge status={row.status} />
                    </TD>
                    <TD numeric>
                      <span className={row.direction === 'receipt' ? 'text-brand-800' : 'text-ink-800'}>
                        {formatMoney(row.amount, row.currency)}
                      </span>
                    </TD>
                    <TD>
                      {row.status === 'completed' && can('payments:write') && (
                        <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setVoidTarget(row)}>
                          Void
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={data?.pagination?.total ?? rows.length} onChange={setPage} />
          </>
        )}
      </Card>

      <NewPaymentModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        currency={currency}
        onSaved={() => {
          setNewOpen(false);
          reload();
          reloadSummary();
        }}
      />

      <ConfirmDialog
        open={voidTarget !== null}
        title="Void this payment?"
        description="Voiding reverses the journal entry and restores the document balance. The record stays in the audit trail."
        confirmLabel="Void payment"
        destructive
        loading={busy}
        onConfirm={() => void voidPayment()}
        onClose={() => setVoidTarget(null)}
      />
    </>
  );
}

function NewPaymentModal({
  open,
  onClose,
  currency,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<'receipt' | 'disbursement'>('receipt');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('bank_transfer');
  const [invoiceId, setInvoiceId] = useState('');
  const [reference, setReference] = useState('');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: invoiceData } = useQuery<{ data: InvoiceOption[] }>(open ? '/invoices?status=sent&pageSize=100' : null);
  const { data: bankData } = useQuery<{ data: Array<{ name: string; accountId: string }> }>(open ? '/banking/accounts' : null);
  const invoices = invoiceData?.data ?? [];
  const selected = invoices.find((invoice) => invoice.id === invoiceId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const amountMinor = toMinor(amount) || selected?.balance || 0;
      if (amountMinor <= 0) throw new Error('Enter an amount.');
      const account = depositAccountId || bankData?.data[0]?.accountId;
      await api.post('/payments', {
        direction,
        date,
        amount: amountMinor,
        method,
        reference: reference || undefined,
        depositAccountId: account ?? null,
        contactId: selected?.contact_id ?? null,
        applications: selected ? [{ invoiceId: selected.id, amount: amountMinor }] : [],
      });
      toast.success('Payment recorded');
      setAmount('');
      setInvoiceId('');
      setReference('');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment"
      description="Offline payments, bank transfers and cheque payments all post to the ledger."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Save payment
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Direction" htmlFor="payment-direction">
          <Select id="payment-direction" value={direction} onChange={(event) => setDirection(event.target.value as 'receipt' | 'disbursement')}>
            <option value="receipt">Money received</option>
            <option value="disbursement">Money paid out</option>
          </Select>
        </Field>
        <Field label="Apply to invoice" htmlFor="payment-invoice" hint="Optional — leave blank for an unapplied payment.">
          <Select
            id="payment-invoice"
            value={invoiceId}
            onChange={(event) => {
              setInvoiceId(event.target.value);
              const invoice = invoices.find((entry) => entry.id === event.target.value);
              if (invoice) setAmount((invoice.balance / 100).toFixed(2));
            }}
            disabled={direction === 'disbursement'}
          >
            <option value="">Unapplied</option>
            {invoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.number} — {invoice.contact_name} ({formatMoney(invoice.balance, currency)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount" required htmlFor="payment-amount">
          <Input id="payment-amount" inputMode="decimal" className="text-right" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Date" htmlFor="payment-date">
          <Input id="payment-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Method" htmlFor="payment-method">
          <Select id="payment-method" value={method} onChange={(event) => setMethod(event.target.value)}>
            {['bank_transfer', 'card', 'ach', 'cash', 'check', 'other'].map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={direction === 'receipt' ? 'Deposit to' : 'Pay from'} htmlFor="payment-account">
          <Select id="payment-account" value={depositAccountId} onChange={(event) => setDepositAccountId(event.target.value)}>
            {(bankData?.data ?? []).map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Reference" htmlFor="payment-reference">
            <Input id="payment-reference" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Bank ref, cheque number…" />
          </Field>
        </div>
        {error && (
          <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
