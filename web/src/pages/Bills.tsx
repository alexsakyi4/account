import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { download, errorMessage, toast, useDebounced, useQuery } from '../lib/data';
import { daysOverdue, daysFromNow, formatDate, formatMoney, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { DocumentComposer, PaymentModal } from '../components/DocumentComposer';
import {
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  Tabs,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface BillRow {
  id: string;
  number: string;
  vendor_id: string;
  vendor_name: string;
  status: string;
  issue_date: string;
  due_date: string;
  currency: string;
  total: number;
  balance: number;
  scheduled_payment_date: string | null;
  journal_entry_id: string | null;
  memo: string | null;
}

interface Vendor {
  id: string;
  name: string;
}

interface BillDetail {
  bill: BillRow;
  lines: Array<{ id: string; description: string; quantity: number; unit_price: number; amount: number; account_code?: string | null; account_name?: string | null }>;
  payments: Array<{ id: string; date: string; amount: number; method: string; number: string }>;
}

const TABS = [
  { id: 'all', label: 'All bills' },
  { id: 'open', label: 'Open' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'paid', label: 'Paid' },
];

export function BillsPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [composerOpen, setComposerOpen] = useState(params.get('new') === '1');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [paymentBill, setPaymentBill] = useState<BillRow | null>(null);
  const [payRunOpen, setPayRunOpen] = useState(false);
  const [through, setThrough] = useState(daysFromNow(7));
  const [depositAccountId, setDepositAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState<BillRow | null>(null);

  const query = useMemo(
    () => ({ page, pageSize: 25, q: debouncedSearch || undefined, status: tab === 'all' ? undefined : tab }),
    [page, debouncedSearch, tab],
  );
  const { data, loading, error, reload } = useQuery<{ data: BillRow[]; pagination?: { total: number } }>('/bills', query);
  const { data: detail, reload: reloadDetail } = useQuery<BillDetail>(focusId ? `/bills/${focusId}` : null);
  const { data: bankData } = useQuery<{ data: Array<{ name: string; accountId: string }> }>(payRunOpen ? '/banking/accounts' : null);

  const rows = data?.data ?? [];
  const scheduledTotal = rows.filter((row) => row.scheduled_payment_date).reduce((sum, row) => sum + row.balance, 0);

  const act = async (bill: BillRow, path: string, message: string) => {
    setBusy(true);
    try {
      await api.post(path, {});
      toast.success(message);
      reload();
      if (focusId === bill.id) reloadDetail();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runPayments = async () => {
    setBusy(true);
    try {
      const account = depositAccountId || bankData?.data[0]?.accountId;
      if (!account) throw new Error('Link a bank account first.');
      const result = await api.post<{ paid: number; total: number }>('/bills/pay-scheduled', { through, depositAccountId: account });
      toast.success('Scheduled payments processed', `${result.paid ?? 0} bills paid.`);
      setPayRunOpen(false);
      reload();
    } catch (err) {
      toast.error('Payment run failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Bills"
        description="Track vendor bills, schedule payments and keep payables accurate."
        actions={
          <>
            {can('payments:write') && (
              <Button variant="secondary" onClick={() => setPayRunOpen(true)}>
                Scheduled payment run
              </Button>
            )}
            {can('bills:write') && (
              <Button
                variant="primary"
                onClick={() => {
                  setComposerOpen(true);
                  const next = new URLSearchParams(params);
                  next.delete('new');
                  setParams(next, { replace: true });
                }}
              >
                + New bill
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Open payables</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">
            {formatMoney(rows.filter((row) => row.status !== 'paid' && row.status !== 'void').reduce((sum, row) => sum + row.balance, 0), currency)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Scheduled this week</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">{formatMoney(scheduledTotal, currency)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Vendors</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">{new Set(rows.map((row) => row.vendor_id)).size}</p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-ink-200 px-4 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs ariaLabel="Bill status" value={tab} onChange={(value) => (setTab(value), setPage(1))} tabs={TABS} />
          <div className="pb-2">
            <Input
              data-search-input
              value={search}
              onChange={(event) => (setSearch(event.target.value), setPage(1))}
              placeholder="Search vendor or number…"
              aria-label="Search bills"
              className="w-56 py-1.5 text-xs"
            />
          </div>
        </div>

        {loading && !data ? (
          <TableSkeleton rows={5} columns={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No bills here"
            description="Bills you record from vendors appear here, ready to schedule and pay."
            action={
              can('bills:write') ? (
                <Button variant="primary" onClick={() => setComposerOpen(true)}>
                  Record a bill
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table caption="Bills">
              <THead>
                <tr>
                  <TH>Number</TH>
                  <TH>Vendor</TH>
                  <TH>Bill date</TH>
                  <TH>Due</TH>
                  <TH>Status</TH>
                  <TH numeric>Total</TH>
                  <TH numeric>Balance</TH>
                  <TH>Actions</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((row) => {
                  const overdue = row.balance > 0 && daysOverdue(row.due_date) > 0 && row.status !== 'paid';
                  return (
                    <TR key={row.id}>
                      <TD>
                        <button onClick={() => setFocusId(row.id)} className="font-medium text-ink-900 hover:underline">
                          {row.number}
                        </button>
                      </TD>
                      <TD className="max-w-48 truncate">{row.vendor_name}</TD>
                      <TD>{formatDate(row.issue_date, 'short')}</TD>
                      <TD>
                        <span className={overdue ? 'font-medium text-red-700' : undefined}>
                          {formatDate(row.due_date, 'short')}
                        </span>
                        {row.scheduled_payment_date && (
                          <p className="text-xs text-ink-500">Scheduled {formatDate(row.scheduled_payment_date, 'short')}</p>
                        )}
                      </TD>
                      <TD>
                        <StatusBadge status={overdue ? 'overdue' : row.status} />
                      </TD>
                      <TD numeric>
                        <Money amount={row.total} currency={row.currency} />
                      </TD>
                      <TD numeric>
                        <Money amount={row.balance} currency={row.currency} />
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {row.status === 'draft' && can('bills:write') && (
                            <Button size="sm" variant="ghost" onClick={() => void act(row, `/bills/${row.id}/post`, 'Bill posted')}>
                              Post
                            </Button>
                          )}
                          {row.balance > 0 && row.status !== 'draft' && can('payments:write') && (
                            <Button size="sm" variant="ghost" onClick={() => setPaymentBill(row)}>
                              Pay
                            </Button>
                          )}
                          {row.status !== 'void' && row.status !== 'paid' && can('bills:write') && (
                            <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setConfirmVoid(row)}>
                              Void
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={data?.pagination?.total ?? rows.length} onChange={setPage} />
          </>
        )}
      </Card>

      <DocumentComposer kind="bill" open={composerOpen} onClose={() => setComposerOpen(false)} onSaved={() => reload()} />

      <PaymentModal
        open={Boolean(paymentBill)}
        onClose={() => setPaymentBill(null)}
        billId={paymentBill?.id}
        contactId={paymentBill?.vendor_id}
        balance={paymentBill?.balance ?? 0}
        currency={paymentBill?.currency ?? currency}
        onPaid={reload}
      />

      <Drawer
        open={Boolean(focusId)}
        onClose={() => setFocusId(null)}
        title={detail?.bill.number ?? 'Bill'}
        description={detail ? `${detail.bill.vendor_name} · due ${formatDate(detail.bill.due_date)}` : undefined}
        footer={
          detail && (
            <>
              <Button variant="secondary" onClick={() => void download(`/bills/${detail.bill.id}/pdf`, `${detail.bill.number}.pdf`)}>
                PDF
              </Button>
              {detail.bill.balance > 0 && detail.bill.status !== 'draft' && can('payments:write') && (
                <Button variant="primary" onClick={() => setPaymentBill(detail.bill)}>
                  Pay bill
                </Button>
              )}
            </>
          )
        }
      >
        {!detail ? (
          <TableSkeleton rows={4} columns={3} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Balance due</p>
                <p className="text-2xl font-semibold text-ink-900">{formatMoney(detail.bill.balance, detail.bill.currency)}</p>
              </div>
              <StatusBadge status={detail.bill.status} />
            </div>
            <Table caption="Bill lines">
              <THead>
                <tr>
                  <TH>Description</TH>
                  <TH numeric>Amount</TH>
                </tr>
              </THead>
              <tbody>
                {detail.lines.map((line) => (
                  <TR key={line.id}>
                    <TD>
                      <p>{line.description}</p>
                      {line.account_code && (
                        <p className="text-xs text-ink-500">
                          {line.account_code} {line.account_name}
                        </p>
                      )}
                    </TD>
                    <TD numeric>{formatMoney(line.amount, detail.bill.currency)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            {detail.payments.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">Payments</h3>
                <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                  {detail.payments.map((payment) => (
                    <li key={payment.id} className="flex justify-between px-4 py-2 text-sm">
                      <span>
                        {formatDate(payment.date)} · {titleCase(payment.method)}
                      </span>
                      <Money amount={payment.amount} currency={detail.bill.currency} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Modal
        open={payRunOpen}
        onClose={() => setPayRunOpen(false)}
        title="Pay scheduled bills"
        description="Every bill scheduled on or before this date is paid in full from the selected bank account."
        size="md"
        footer={
          <>
            <Button onClick={() => setPayRunOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void runPayments()}>
              Run payments
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Pay bills through" htmlFor="run-through">
            <Input id="run-through" type="date" value={through} onChange={(event) => setThrough(event.target.value)} />
          </Field>
          <Field label="Pay from" htmlFor="run-account">
            <Select id="run-account" value={depositAccountId} onChange={(event) => setDepositAccountId(event.target.value)}>
              {(bankData?.data ?? []).map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
            Scheduled total in view: <strong>{formatMoney(scheduledTotal, currency)}</strong>. Each payment posts a balanced
            journal entry and can be voided later.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmVoid !== null}
        title="Void this bill?"
        description="Voiding reverses the payable and expense entries while keeping the document for your audit trail."
        confirmLabel="Void bill"
        destructive
        onConfirm={async () => {
          if (confirmVoid) await act(confirmVoid, `/bills/${confirmVoid.id}/void`, 'Bill voided');
          setConfirmVoid(null);
        }}
        onClose={() => setConfirmVoid(null)}
      />
    </>
  );
}
