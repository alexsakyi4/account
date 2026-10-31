import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { download, errorMessage, toast, useDebounced, useQuery } from '../lib/data';
import { formatDate, formatMoney, titleCase, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
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
  Textarea,
} from '../components/ui';

interface ContactRow {
  id: string;
  kind: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number;
  creditLimit: number | null;
  currency: string;
  isActive: boolean;
  openInvoices: number;
  openBills: number;
  lastInvoiceDate: string | null;
}

interface ContactDetail {
  contact: ContactRow & { billing_address_json?: string | null; notes?: string | null; tax_id?: string | null };
  invoices?: Array<{ id: string; number: string; issue_date: string; due_date: string; status: string; total: number; balance: number }>;
  bills?: Array<{ id: string; number: string; issue_date: string; due_date: string; status: string; total: number; balance: number }>;
  statement?: Array<{ date: string; type: string; number: string; amount: number; balance: number }>;
}

export function ContactsPage({ kind }: { kind: 'customer' | 'vendor' }): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const isCustomer = kind === 'customer';
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ContactRow | 'new' | null>(null);

  const query = useMemo(() => ({ kind, page, pageSize: 25, q: debounced || undefined }), [kind, page, debounced]);
  const { data, loading, error, reload } = useQuery<{ data: ContactRow[]; pagination?: { total: number } }>('/contacts', query);
  const { data: detail, reload: reloadDetail } = useQuery<ContactDetail>(detailId ? `/contacts/${detailId}` : null);

  const rows = data?.data ?? [];
  const totalOpen = rows.reduce((sum, row) => sum + (isCustomer ? row.openInvoices : row.openBills), 0);

  return (
    <>
      <PageHeader
        title={isCustomer ? 'Customers' : 'Vendors'}
        description={
          isCustomer
            ? 'Payment terms, credit limits and open balances for every customer.'
            : 'Suppliers you buy from, with terms and outstanding payables.'
        }
        actions={
          can(isCustomer ? 'invoices:write' : 'bills:write') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + New {isCustomer ? 'customer' : 'vendor'}
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">{isCustomer ? 'Open receivable' : 'Open payable'} (this page)</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">{formatMoney(totalOpen, currency)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Total {isCustomer ? 'customers' : 'vendors'}</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">{data?.pagination?.total ?? rows.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Default terms</p>
          <p className="mt-1 text-xl font-semibold text-ink-900">
            {rows.length ? `Net ${Math.round(rows.reduce((sum, row) => sum + row.paymentTermsDays, 0) / rows.length)}` : '—'}
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">{isCustomer ? 'Customer list' : 'Vendor list'}</h2>
          <Input
            data-search-input
            value={search}
            onChange={(event) => (setSearch(event.target.value), setPage(1))}
            placeholder={`Search ${isCustomer ? 'customers' : 'vendors'}…`}
            aria-label={`Search ${isCustomer ? 'customers' : 'vendors'}`}
            className="w-56 py-1.5 text-xs"
          />
        </div>

        {loading && !data ? (
          <TableSkeleton rows={6} columns={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`No ${isCustomer ? 'customers' : 'vendors'} yet`}
            description={`Add your first ${isCustomer ? 'customer' : 'vendor'} to invoice and pay against.`}
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Add {isCustomer ? 'customer' : 'vendor'}
              </Button>
            }
          />
        ) : (
          <>
            <Table caption={isCustomer ? 'Customers' : 'Vendors'}>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Terms</TH>
                  <TH numeric>{isCustomer ? 'Credit limit' : 'Open balance'}</TH>
                  <TH numeric>{isCustomer ? 'Open balance' : 'Bills open'}</TH>
                  <TH>Last activity</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((row) => (
                  <TR key={row.id} onClick={() => setDetailId(row.id)}>
                    <TD>
                      <p className="font-medium text-ink-900">{row.name}</p>
                      {row.companyName && row.companyName !== row.name && <p className="text-xs text-ink-500">{row.companyName}</p>}
                    </TD>
                    <TD className="max-w-52 truncate">{row.email ?? '—'}</TD>
                    <TD>Net {row.paymentTermsDays}</TD>
                    <TD numeric>{isCustomer ? (row.creditLimit ? formatMoney(row.creditLimit, row.currency) : '—') : formatMoney(row.openBills, currency)}</TD>
                    <TD numeric>
                      <Money amount={isCustomer ? row.openInvoices : row.openBills} currency={currency} />
                    </TD>
                    <TD>{row.lastInvoiceDate ? formatDate(row.lastInvoiceDate, 'short') : '—'}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={data?.pagination?.total ?? rows.length} onChange={setPage} />
          </>
        )}
      </Card>

      <Drawer
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
        title={detail?.contact.name ?? 'Contact'}
        description={detail?.contact.email ?? undefined}
        footer={
          detail && (
            <>
              <Button variant="secondary" onClick={() => setEditing(detail.contact)}>
                Edit
              </Button>
              {isCustomer && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const result = await api.post<{ url: string }>(`/contacts/${detail.contact.id}/portal-link`, {});
                      await navigator.clipboard?.writeText(`${window.location.origin}${result.url}`);
                      toast.success('Portal link copied', 'Share it with the customer to view their statement.');
                    } catch (err) {
                      toast.error('Could not create link', errorMessage(err));
                    }
                  }}
                >
                  Customer portal link
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => void download(`/contacts/${detail.contact.id}/statement`, `${detail.contact.name}-statement.csv`)}
              >
                Download statement
              </Button>
            </>
          )
        }
      >
        {!detail ? (
          <TableSkeleton rows={4} columns={3} />
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-4 rounded-lg bg-ink-50 p-4 text-sm">
              <div>
                <dt className="text-xs text-ink-500">Terms</dt>
                <dd className="font-medium text-ink-900">Net {detail.contact.paymentTermsDays}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Currency</dt>
                <dd className="font-medium text-ink-900">{detail.contact.currency}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">{isCustomer ? 'Open invoices' : 'Open bills'}</dt>
                <dd className="font-medium text-ink-900">
                  {formatMoney(isCustomer ? detail.contact.openInvoices : detail.contact.openBills, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Credit limit</dt>
                <dd className="font-medium text-ink-900">
                  {detail.contact.creditLimit ? formatMoney(detail.contact.creditLimit, detail.contact.currency) : 'No limit set'}
                </dd>
              </div>
            </dl>

            {detail.invoices && detail.invoices.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">Invoices</h3>
                <Table caption="Invoices">
                  <THead>
                    <tr>
                      <TH>Number</TH>
                      <TH>Date</TH>
                      <TH>Status</TH>
                      <TH numeric>Balance</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {detail.invoices.map((invoice) => (
                      <TR key={invoice.id}>
                        <TD>{invoice.number}</TD>
                        <TD>{formatDate(invoice.issue_date, 'short')}</TD>
                        <TD>
                          <StatusBadge status={invoice.status} />
                        </TD>
                        <TD numeric>{formatMoney(invoice.balance, currency)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            {detail.bills && detail.bills.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">Bills</h3>
                <Table caption="Bills">
                  <THead>
                    <tr>
                      <TH>Number</TH>
                      <TH>Date</TH>
                      <TH>Status</TH>
                      <TH numeric>Balance</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {detail.bills.map((bill) => (
                      <TR key={bill.id}>
                        <TD>{bill.number}</TD>
                        <TD>{formatDate(bill.issue_date, 'short')}</TD>
                        <TD>
                          <StatusBadge status={bill.status} />
                        </TD>
                        <TD numeric>{formatMoney(bill.balance, currency)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            {detail.contact.notes && <p className="text-sm text-ink-600">{detail.contact.notes}</p>}
          </div>
        )}
      </Drawer>

      <ContactForm
        open={editing !== null}
        contact={editing === 'new' ? null : editing}
        kind={kind}
        currency={currency}
        onClose={() => setEditing(null)}
        onSaved={() => {
          reload();
          setEditing(null);
          if (detailId) reloadDetail();
        }}
      />
    </>
  );
}

function ContactForm({
  open,
  contact,
  kind,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  contact: ContactRow | null;
  kind: 'customer' | 'vendor';
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState({
    name: '',
    companyName: '',
    email: '',
    phone: '',
    paymentTermsDays: '30',
    creditLimit: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState<string | null>(null);

  const formKey = contact?.id ?? (open ? 'new' : null);
  useEffect(() => {
    if (!open || formKey === initialised) return;
    setInitialised(formKey);
    setForm({
      name: contact?.name ?? '',
      companyName: contact?.companyName ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      paymentTermsDays: String(contact?.paymentTermsDays ?? 30),
      creditLimit: contact?.creditLimit ? (contact.creditLimit / 100).toFixed(2) : '',
      notes: '',
    });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, formKey]);

  const submit = async () => {
    if (form.name.trim().length < 2) {
      setError('Enter a name with at least two characters.');
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      name: form.name.trim(),
      kind,
      companyName: form.companyName.trim() || undefined,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      paymentTermsDays: Number(form.paymentTermsDays) || 0,
      creditLimit: form.creditLimit ? toMinor(form.creditLimit) : null,
      currency,
    };
    try {
      if (contact) await api.patch(`/contacts/${contact.id}`, payload);
      else await api.post('/contacts', payload);
      toast.success(contact ? 'Contact updated' : 'Contact created');
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
      title={contact ? `Edit ${contact.name}` : `New ${kind}`}
      description={kind === 'customer' ? 'Customers receive invoices and statements.' : 'Vendors send bills you pay.'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {contact ? 'Save changes' : `Add ${kind}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required htmlFor="contact-name">
          <Input id="contact-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Company" htmlFor="contact-company">
          <Input id="contact-company" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
        </Field>
        <Field label="Email" htmlFor="contact-email">
          <Input id="contact-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </Field>
        <Field label="Phone" htmlFor="contact-phone">
          <Input id="contact-phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
        </Field>
        <Field label="Payment terms (days)" htmlFor="contact-terms">
          <Select id="contact-terms" value={form.paymentTermsDays} onChange={(event) => setForm({ ...form, paymentTermsDays: event.target.value })}>
            {[0, 7, 14, 15, 30, 45, 60, 90].map((days) => (
              <option key={days} value={days}>
                {days === 0 ? 'Due on receipt' : `Net ${days}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Credit limit" htmlFor="contact-limit" hint={kind === 'customer' ? 'Warn before exceeding open balance.' : 'Optional'}>
          <Input id="contact-limit" inputMode="decimal" value={form.creditLimit} onChange={(event) => setForm({ ...form, creditLimit: event.target.value })} placeholder="0.00" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes" htmlFor="contact-notes">
            <Textarea id="contact-notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
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
