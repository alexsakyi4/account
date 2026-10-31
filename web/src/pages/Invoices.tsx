import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { download, errorMessage, toast, useDebounced, useQuery } from '../lib/data';
import { classNames, daysOverdue, formatDate, formatMoney, titleCase } from '../lib/format';
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
  TD,
  TH,
  THead,
  TR,
  Tabs,
  Textarea,
} from '../components/ui';

interface InvoiceRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  contact_id: string;
  contact_name: string;
  issue_date: string;
  due_date: string | null;
  currency: string;
  total: number;
  amount_paid: number;
  balance: number;
  memo: string | null;
  journal_entry_id: string | null;
  reminder_count: number;
}

interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  tax_amount: number;
  account_code?: string | null;
  account_name?: string | null;
}

interface InvoiceDetail {
  invoice: InvoiceRow & { terms: string | null; po_number: string | null; payment_link_token: string | null; contact_email: string | null };
  lines: InvoiceLine[];
  payments: Array<{ id: string; date: string; amount: number; method: string; number: string }>;
  journalEntry?: { entry_no: number; id: string } | null;
}

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'sent', label: 'Sent' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
];

export function InvoicesPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('status') ?? 'all');
  const [kind, setKind] = useState(params.get('kind') ?? 'invoice');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [composerOpen, setComposerOpen] = useState(params.get('new') === '1');
  const [selected, setSelected] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(params.get('focus'));
  const [confirmBulk, setConfirmBulk] = useState<'void' | 'post' | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(
    () => ({
      page,
      pageSize: 25,
      q: debouncedSearch || undefined,
      kind,
      status: tab === 'all' ? undefined : tab,
    }),
    [page, debouncedSearch, kind, tab],
  );

  const { data, loading, error, reload } = useQuery<{ data: InvoiceRow[]; pagination?: { total: number; pageSize: number } }>('/invoices', query);
  const { data: detail, reload: reloadDetail } = useQuery<InvoiceDetail>(focusId ? `/invoices/${focusId}` : null);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (tab === 'all') next.delete('status');
    else next.set('status', tab);
    if (kind === 'invoice') next.delete('kind');
    else next.set('kind', kind);
    next.delete('new');
    setParams(next, { replace: true });
    setPage(1);
    setSelected([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, kind]);

  const rows = data?.data ?? [];
  const total = data?.pagination?.total ?? rows.length;
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  const act = async (path: string, action: string, success: string) => {
    setBusy(true);
    try {
      await api.post(path, {});
      toast.success(success);
      reload();
      if (focusId) reloadDetail();
    } catch (err) {
      toast.error(`${action} failed`, errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bulk = async () => {
    if (!confirmBulk) return;
    setBusy(true);
    try {
      const result = await api.post<{ affected: number }>('/invoices/bulk', { ids: selected, action: confirmBulk });
      toast.success(`${result.affected ?? selected.length} invoices updated`, titleCase(confirmBulk));
      setSelected([]);
      setConfirmBulk(null);
      reload();
    } catch (err) {
      toast.error('Bulk update failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const invoice = detail?.invoice;

  return (
    <>
      <PageHeader
        title={kind === 'estimate' ? 'Estimates' : kind === 'credit_memo' ? 'Credit memos' : 'Invoices'}
        description="Create, send and collect. Every posted invoice writes a balanced journal entry."
        actions={
          <>
            {can('invoices:write') && (
              <Button variant="primary" onClick={() => setComposerOpen(true)}>
                + New {kind === 'estimate' ? 'estimate' : kind === 'credit_memo' ? 'credit memo' : 'invoice'}
              </Button>
            )}
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-ink-200 px-4 pt-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              ariaLabel="Invoice status"
              value={tab}
              onChange={setTab}
              tabs={STATUS_TABS.map((entry) => ({ id: entry.id, label: entry.label }))}
            />
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <Select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Document type" className="w-44 py-1.5 text-xs">
                <option value="invoice">Invoices</option>
                <option value="estimate">Estimates</option>
                <option value="credit_memo">Credit memos</option>
              </Select>
              <Input
                data-search-input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search number or customer…"
                aria-label="Search invoices"
                className="w-56 py-1.5 text-xs"
              />
            </div>
          </div>
        </div>

        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-brand-50 px-4 py-2 text-sm">
            <span className="font-medium text-brand-900">{selected.length} selected</span>
            <Button size="sm" onClick={() => setConfirmBulk('post')}>
              Post
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmBulk('void')}>
              Void
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </div>
        )}

        {loading && !data ? (
          <TableSkeleton rows={6} columns={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`No ${kind === 'invoice' ? 'invoices' : kind === 'estimate' ? 'estimates' : 'credit memos'} yet`}
            description={
              debouncedSearch
                ? 'Nothing matches that search. Try a different number or customer.'
                : 'Create your first document — it takes about 30 seconds.'
            }
            action={
              can('invoices:write') ? (
                <Button variant="primary" onClick={() => setComposerOpen(true)}>
                  Create {kind === 'estimate' ? 'estimate' : kind === 'credit_memo' ? 'credit memo' : 'invoice'}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table caption="Invoices">
              <THead>
                <tr>
                  <th scope="col" className="th w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all invoices on this page"
                      checked={allSelected}
                      onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])}
                      className="h-4 w-4 rounded border-ink-300 text-brand-700"
                    />
                  </th>
                  <TH>Number</TH>
                  <TH>Customer</TH>
                  <TH>Issued</TH>
                  <TH>Due</TH>
                  <TH>Status</TH>
                  <TH numeric>Total</TH>
                  <TH numeric>Balance</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((row) => {
                  const overdue = row.balance > 0 && row.due_date && daysOverdue(row.due_date) > 0 && ['sent', 'partial', 'overdue'].includes(row.status);
                  return (
                    <TR key={row.id} selected={selected.includes(row.id)}>
                      <TD>
                        <input
                          type="checkbox"
                          aria-label={`Select invoice ${row.number}`}
                          checked={selected.includes(row.id)}
                          onChange={(event) =>
                            setSelected((current) => (event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id)))
                          }
                          className="h-4 w-4 rounded border-ink-300 text-brand-700"
                        />
                      </TD>
                      <TD>
                        <button onClick={() => setFocusId(row.id)} className="font-medium text-ink-900 hover:underline">
                          {row.number}
                        </button>
                      </TD>
                      <TD className="max-w-48 truncate">{row.contact_name}</TD>
                      <TD>{formatDate(row.issue_date, 'short')}</TD>
                      <TD>
                        <span className={classNames(overdue && 'font-medium text-red-700')}>
                          {formatDate(row.due_date, 'short')}
                          {overdue && <span className="ml-1 text-xs">({daysOverdue(row.due_date)}d)</span>}
                        </span>
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
                    </TR>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={total} onChange={setPage} />
          </>
        )}
      </Card>

      <DocumentComposer
        kind={kind as 'invoice' | 'estimate' | 'credit_memo'}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSaved={(id) => {
          reload();
          setFocusId(id);
        }}
      />

      <InvoiceDrawer
        open={Boolean(focusId)}
        onClose={() => setFocusId(null)}
        detail={detail}
        currency={currency}
        canWrite={can('invoices:write')}
        busy={busy}
        onAction={async (action) => {
          if (!invoice) return;
          if (action === 'pdf') {
            await download(`/invoices/${invoice.id}/pdf`, `${invoice.number}.pdf`);
            return;
          }
          const map: Record<string, { path: string; message: string }> = {
            post: { path: `/invoices/${invoice.id}/post`, message: 'Invoice posted to the ledger' },
            send: { path: `/invoices/${invoice.id}/send`, message: 'Invoice email queued' },
            remind: { path: `/invoices/${invoice.id}/remind`, message: 'Reminder sent' },
            void: { path: `/invoices/${invoice.id}/void`, message: 'Invoice voided' },
            duplicate: { path: `/invoices/${invoice.id}/duplicate`, message: 'Draft copy created' },
          };
          const target = map[action];
          if (target) await act(target.path, action, target.message);
        }}
        onPaid={() => {
          reload();
          reloadDetail();
        }}
      />

      <ConfirmDialog
        open={confirmBulk !== null}
        title={confirmBulk === 'void' ? 'Void selected invoices?' : 'Post selected invoices?'}
        description={
          confirmBulk === 'void'
            ? 'Voiding reverses the ledger impact and keeps the documents for the audit trail.'
            : 'Posting creates journal entries for every selected draft. This cannot be undone without voiding.'
        }
        confirmLabel={confirmBulk === 'void' ? 'Void invoices' : 'Post invoices'}
        destructive={confirmBulk === 'void'}
        loading={busy}
        onConfirm={() => void bulk()}
        onClose={() => setConfirmBulk(null)}
      />
    </>
  );
}

function InvoiceDrawer({
  open,
  onClose,
  detail,
  currency,
  canWrite,
  busy,
  onAction,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  detail: InvoiceDetail | null;
  currency: string;
  canWrite: boolean;
  busy: boolean;
  onAction: (action: string) => void | Promise<void>;
  onPaid: () => void;
}): React.JSX.Element {
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [message, setMessage] = useState('');
  const invoice = detail?.invoice;
  if (!invoice) {
    return (
      <Drawer open={open} onClose={onClose} title="Invoice">
        <TableSkeleton rows={5} columns={3} />
      </Drawer>
    );
  }
  const canPost = invoice.status === 'draft';
  const canPay = invoice.balance > 0 && !['void', 'draft'].includes(invoice.status);

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={`${invoice.number}`}
        description={`${invoice.contact_name} · ${formatDate(invoice.issue_date)} · `}
        footer={
          <div className="flex flex-wrap gap-2">
            {canWrite && canPost && (
              <Button variant="primary" loading={busy} onClick={() => void onAction('post')}>
                Post to ledger
              </Button>
            )}
            {canWrite && canPost && (
              <Button
                variant="secondary"
                onClick={() => setSendOpen(true)}
              >
                Send by email
              </Button>
            )}
            {canWrite && !canPost && invoice.status !== 'void' && invoice.balance > 0 && (
              <Button variant="secondary" loading={busy} onClick={() => void onAction('remind')}>
                Send reminder
              </Button>
            )}
            {canWrite && canPay && (
              <Button variant="primary" onClick={() => setPaymentOpen(true)}>
                Record payment
              </Button>
            )}
            <Button variant="secondary" onClick={() => void onAction('pdf')}>
              PDF
            </Button>
            {canWrite && (
              <Button variant="ghost" loading={busy} onClick={() => void onAction('duplicate')}>
                Duplicate
              </Button>
            )}
            {canWrite && invoice.status !== 'void' && invoice.status !== 'paid' && (
              <Button variant="ghost" className="text-red-700" loading={busy} onClick={() => void onAction('void')}>
                Void
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-500">Amount due</p>
              <p className="text-3xl font-semibold text-ink-900">
                <Money amount={invoice.balance} currency={invoice.currency} />
              </p>
              <p className="mt-1 text-xs text-ink-500">
                of {formatMoney(invoice.total, invoice.currency)} total · paid {formatMoney(invoice.amount_paid, invoice.currency)}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusBadge status={invoice.status} />
              {invoice.journal_entry_id ? (
                <span className="text-xs text-brand-800">Posted to journal</span>
              ) : (
                <span className="text-xs text-ink-500">Not yet posted</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 rounded-lg bg-ink-50 p-4 text-sm">
            <div>
              <p className="text-xs text-ink-500">Due date</p>
              <p className="font-medium text-ink-900">{formatDate(invoice.due_date)}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Customer email</p>
              <p className="truncate font-medium text-ink-900">{invoice.contact_email ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Terms</p>
              <p className="font-medium text-ink-900">{invoice.terms ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-500">Reminders sent</p>
              <p className="font-medium text-ink-900">{invoice.reminder_count}</p>
            </div>
          </div>

          <Table caption="Invoice lines">
            <THead>
              <tr>
                <TH>Description</TH>
                <TH numeric>Qty</TH>
                <TH numeric>Unit</TH>
                <TH numeric>Tax</TH>
                <TH numeric>Amount</TH>
              </tr>
            </THead>
            <tbody>
              {detail.lines.map((line) => (
                <TR key={line.id}>
                  <TD>
                    <p className="font-medium text-ink-800">{line.description}</p>
                    {line.account_code && (
                      <p className="text-xs text-ink-500">
                        {line.account_code} {line.account_name}
                      </p>
                    )}
                  </TD>
                  <TD numeric>{line.quantity}</TD>
                  <TD numeric>
                    <Money amount={line.unit_price} currency={invoice.currency} />
                  </TD>
                  <TD numeric>
                    <Money amount={line.tax_amount} currency={invoice.currency} />
                  </TD>
                  <TD numeric>
                    <Money amount={line.amount} currency={invoice.currency} />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>

          <dl className="ml-auto max-w-xs space-y-1 text-sm">
            <div className="flex justify-between text-ink-600">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(invoice.total - (detail.lines.reduce((sum, l) => sum + l.tax_amount, 0)), invoice.currency)}</dd>
            </div>
            <div className="flex justify-between text-ink-600">
              <dt>Tax</dt>
              <dd className="tabular-nums">{formatMoney(detail.lines.reduce((sum, l) => sum + l.tax_amount, 0), invoice.currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-ink-200 pt-1 font-semibold text-ink-900">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(invoice.total, invoice.currency)}</dd>
            </div>
          </dl>

          {invoice.memo && (
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-500">Memo</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{invoice.memo}</p>
            </div>
          )}

          {detail.payments.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-900">Payments</h3>
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                {detail.payments.map((payment) => (
                  <li key={payment.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>
                      {formatDate(payment.date)} · <span className="capitalize">{payment.method.replace(/_/g, ' ')}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Money amount={payment.amount} currency={invoice.currency} />
                      <StatusBadge status="posted" label="Applied" />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Drawer>

      <PaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        invoiceId={invoice.id}
        contactId={invoice.contact_id}
        balance={invoice.balance}
        currency={invoice.currency || currency}
        onPaid={onPaid}
      />

      <Modal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        title={`Send ${invoice.number}`}
        description="The customer receives an email with a secure payment link. Posting happens automatically."
        footer={
          <>
            <Button onClick={() => setSendOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                await onAction('send');
                setSendOpen(false);
              }}
            >
              Send invoice
            </Button>
          </>
        }
      >
        <Field label="Message to customer" htmlFor="send-message">
          <Textarea
            id="send-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Hi there — here's the invoice for this month's work."
          />
        </Field>
      </Modal>
    </>
  );
}
