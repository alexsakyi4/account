import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { daysFromNow, formatDate, titleCase, today, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface Recurring {
  id: string;
  name: string;
  contact_id: string;
  contact_name: string;
  frequency: string;
  interval_count: number;
  next_date: string;
  end_date: string | null;
  auto_send: number;
  status: string;
  last_run_at: string | null;
  template: { lines: Array<{ description: string; quantity: number; unitPrice: number }>; memo?: string };
}

export function RecurringPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const { data, loading, reload } = useQuery<{ data: Recurring[] }>('/recurring-invoices');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const creation = useCreation(reload);

  const setStatus = async (row: Recurring, status: 'active' | 'paused' | 'ended') => {
    setBusy(row.id);
    try {
      await api.patch(`/recurring-invoices/${row.id}`, { status });
      toast.success(`Schedule ${status}`);
      reload();
    } catch (err) {
      toast.error('Could not update schedule', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Recurring invoices"
        description="Issue invoices on a schedule. The background worker creates and optionally sends them."
        actions={
          can('invoices:write') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              + New schedule
            </Button>
          ) : undefined
        }
      />

      <Card className="overflow-hidden">
        {loading && !data ? (
          <TableSkeleton rows={4} columns={5} />
        ) : !data?.data.length ? (
          <EmptyState title="No recurring schedules" description="Set up retainers and subscriptions so invoices are created automatically." />
        ) : (
          <Table caption="Recurring invoices">
            <THead>
              <tr>
                <TH>Schedule</TH>
                <TH>Customer</TH>
                <TH>Frequency</TH>
                <TH>Next run</TH>
                <TH>Status</TH>
                <TH>Actions</TH>
              </tr>
            </THead>
            <tbody>
              {data.data.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <p className="font-medium text-ink-900">{row.name}</p>
                    <p className="text-xs text-ink-500">
                      {row.template.lines.length} lines · {row.auto_send ? 'auto-sends' : 'creates drafts'}
                    </p>
                  </TD>
                  <TD>{row.contact_name}</TD>
                  <TD className="capitalize">
                    {row.frequency} {row.interval_count > 1 ? `× ${row.interval_count}` : ''}
                  </TD>
                  <TD>{formatDate(row.next_date)}</TD>
                  <TD>
                    <StatusBadge status={row.status} />
                  </TD>
                  <TD>
                    <div className="flex gap-1">
                      {row.status === 'active' && (
                        <Button size="sm" variant="ghost" loading={busy === row.id} onClick={() => void setStatus(row, 'paused')}>
                          Pause
                        </Button>
                      )}
                      {row.status !== 'active' && (
                        <Button size="sm" variant="ghost" loading={busy === row.id} onClick={() => void setStatus(row, 'active')}>
                          Resume
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="text-red-700" loading={busy === row.id} onClick={() => void setStatus(row, 'ended')}>
                        End
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New recurring invoice"
        description="A draft (or a sent invoice) is created each time the schedule falls due."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={creation.saving} onClick={() => void creation.submit().then((ok) => ok && setOpen(false))}>
              Create schedule
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Schedule name" required htmlFor="recurring-name">
            <Input id="recurring-name" value={creation.form.name} onChange={(event) => creation.set('name', event.target.value)} placeholder="Monthly retainer" />
          </Field>
          <Field label="Customer" required htmlFor="recurring-customer">
            <Select id="recurring-customer" value={creation.form.contactId} onChange={(event) => creation.set('contactId', event.target.value)}>
              <option value="">Select customer…</option>
              {creation.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Frequency" htmlFor="recurring-frequency">
            <Select id="recurring-frequency" value={creation.form.frequency} onChange={(event) => creation.set('frequency', event.target.value)}>
              {['weekly', 'monthly', 'quarterly', 'yearly'].map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="First invoice date" htmlFor="recurring-next">
            <Input id="recurring-next" type="date" value={creation.form.nextDate} onChange={(event) => creation.set('nextDate', event.target.value)} />
          </Field>
          <Field label="Description" htmlFor="recurring-description">
            <Input id="recurring-description" value={creation.form.description} onChange={(event) => creation.set('description', event.target.value)} placeholder="Monthly support" />
          </Field>
          <Field label={`Amount (${currency})`} required htmlFor="recurring-amount">
            <Input id="recurring-amount" inputMode="decimal" className="text-right" value={creation.form.amount} onChange={(event) => creation.set('amount', event.target.value)} />
          </Field>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={creation.form.autoSend}
              onChange={(event) => creation.set('autoSend', event.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-700"
            />
            Post and email the invoice automatically
          </label>
          {creation.error && (
            <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {creation.error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

function useCreation(onSaved: () => void) {
  const { data: contactData } = useQuery<{ data: Array<{ id: string; name: string }> }>('/contacts?kind=customer&pageSize=200');
  const { data: accountData } = useQuery<{ data: Array<{ id: string; code: string; name: string; type: string }> }>('/accounts?pageSize=300');
  const [form, setForm] = useState({
    name: '',
    contactId: '',
    frequency: 'monthly',
    nextDate: daysFromNow(7),
    description: '',
    amount: '',
    autoSend: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const incomeAccount = (accountData?.data ?? []).find((account) => account.code === '4000')?.id ?? (accountData?.data ?? []).find((account) => account.type === 'income')?.id;

  const submit = async (): Promise<boolean> => {
    setError(null);
    if (!form.contactId || !form.name) {
      setError('Give the schedule a name and choose a customer.');
      return false;
    }
    if (!incomeAccount) {
      setError('Add an income account first.');
      return false;
    }
    setSaving(true);
    try {
      await api.post('/recurring-invoices', {
        name: form.name,
        contactId: form.contactId,
        frequency: form.frequency,
        nextDate: form.nextDate || today(),
        autoSend: form.autoSend,
        lines: [{ description: form.description || form.name, quantity: 1, unitPrice: toMinor(form.amount), accountId: incomeAccount }],
      });
      toast.success('Schedule created', 'The worker issues the first invoice on the start date.');
      onSaved();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { form, set, submit, saving, error, customers: contactData?.data ?? [] };
}
