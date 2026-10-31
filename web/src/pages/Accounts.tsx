import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useDebounced, useQuery } from '../lib/data';
import { formatMoney, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  HelpTip,
  Input,
  Modal,
  Money,
  PageHeader,
  Select,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from '../components/ui';

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  parentId: string | null;
  description: string | null;
  isSystem: boolean;
  systemKey: string | null;
  isActive: boolean;
  childCount: number;
  balance: number;
}

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_LABELS: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

export function AccountsPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [typeFilter, setTypeFilter] = useState('all');
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const { data, loading, error, reload } = useQuery<{ data: Account[] }>('/accounts', {
    pageSize: 300,
    q: debounced || undefined,
  });

  const accounts = data?.data ?? [];
  const grouped = useMemo(() => {
    const filtered = typeFilter === 'all' ? accounts : accounts.filter((account) => account.type === typeFilter);
    return TYPE_ORDER.map((type) => ({
      type,
      rows: filtered.filter((account) => account.type === type),
    })).filter((group) => group.rows.length > 0);
  }, [accounts, typeFilter]);

  const totalByType = (type: string) => accounts.filter((account) => account.type === type).reduce((sum, account) => sum + account.balance, 0);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="The backbone of your books. Accounts are grouped by type and roll up to the reports."
        actions={
          <>
            {can('accounts:write') && (
              <Button variant="secondary" onClick={() => setTemplateOpen(true)}>
                Apply industry template
              </Button>
            )}
            {can('accounts:write') && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                + New account
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {TYPE_ORDER.map((type) => (
          <Card key={type} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">{TYPE_LABELS[type]}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-900">{formatMoney(totalByType(type), currency)}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">All accounts</h2>
          <div className="flex items-center gap-2">
            <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by type" className="w-36 py-1.5 text-xs">
              <option value="all">All types</option>
              {TYPE_ORDER.map((type) => (
                <option key={type} value={type}>
                  {titleCase(type)}
                </option>
              ))}
            </Select>
            <Input
              data-search-input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or code"
              aria-label="Search accounts"
              className="w-48 py-1.5 text-xs"
            />
          </div>
        </div>

        {loading && !data ? (
          <TableSkeleton rows={8} columns={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : grouped.length === 0 ? (
          <EmptyState title="No accounts match" description="Try a different search or apply an industry template." />
        ) : (
          grouped.map((group) => (
            <div key={group.type}>
              <div className="flex items-center justify-between bg-ink-50 px-4 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-600">{TYPE_LABELS[group.type]}</h3>
                <span className="text-xs font-medium tabular-nums text-ink-600">{formatMoney(totalByType(group.type), currency)}</span>
              </div>
              <Table caption={TYPE_LABELS[group.type]}>
                <THead>
                  <tr>
                    <TH>Code</TH>
                    <TH>Account</TH>
                    <TH>Type</TH>
                    <TH numeric>Balance</TH>
                    <TH>Flags</TH>
                  </tr>
                </THead>
                <tbody>
                  {group.rows.map((account) => (
                    <TR key={account.id} onClick={() => can('accounts:write') && setEditing(account)}>
                      <TD className="tabular-nums">{account.code}</TD>
                      <TD>
                        <p className="font-medium text-ink-900">{account.name}</p>
                        {account.description && <p className="text-xs text-ink-500">{account.description}</p>}
                      </TD>
                      <TD className="capitalize text-xs text-ink-600">{account.subtype ? account.subtype.replace(/_/g, ' ') : account.type}</TD>
                      <TD numeric>
                        <Money amount={account.balance} currency={currency} />
                      </TD>
                      <TD>
                        <span className="flex flex-wrap gap-1">
                          {account.isSystem && (
                            <span className="badge bg-ink-100 text-ink-600" title="Managed by LedgerLine posting rules">
                              System
                            </span>
                          )}
                          {!account.isActive && <span className="badge bg-ink-200 text-ink-600">Inactive</span>}
                        </span>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
          ))
        )}
      </Card>

      <AccountForm
        open={editing !== null}
        account={editing === 'new' ? null : editing}
        accounts={accounts}
        onClose={() => setEditing(null)}
        onSaved={() => {
          reload();
          setEditing(null);
        }}
      />

      <TemplateModal open={templateOpen} onClose={() => setTemplateOpen(false)} onApplied={reload} />
    </>
  );
}

function AccountForm({
  open,
  account,
  accounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  account: Account | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState({ code: '', name: '', type: 'expense', subtype: '', parentId: '', description: '', isActive: true });
  const [initialised, setInitialised] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = account?.id ?? (open ? 'new' : null);
  useEffect(() => {
    if (!open || key === initialised) return;
    setInitialised(key);
    setForm({
      code: account?.code ?? '',
      name: account?.name ?? '',
      type: account?.type ?? 'expense',
      subtype: account?.subtype ?? '',
      parentId: account?.parentId ?? '',
      description: account?.description ?? '',
      isActive: account?.isActive ?? true,
    });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        subtype: form.subtype || undefined,
        parentId: form.parentId || null,
        description: form.description || undefined,
        isActive: form.isActive,
      };
      if (account) await api.patch(`/accounts/${account.id}`, payload);
      else await api.post('/accounts', payload);
      toast.success(account ? 'Account updated' : 'Account created');
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
      title={account ? `Edit ${account.code} ${account.name}` : 'New account'}
      description={account?.isSystem ? 'This is a system account used by posting rules. Rename it if you like; the code stays linked.' : undefined}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {account ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" required htmlFor="account-code" hint="Numbers keep the chart sorted (e.g. 6100).">
          <Input id="account-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        </Field>
        <Field label="Name" required htmlFor="account-name">
          <Input id="account-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Type" required htmlFor="account-type">
          <Select id="account-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} disabled={account?.isSystem}>
            {TYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {titleCase(type)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Detail type" htmlFor="account-subtype">
          <Input id="account-subtype" value={form.subtype} onChange={(event) => setForm({ ...form, subtype: event.target.value })} placeholder="bank, cogs, other_expense…" />
        </Field>
        <Field label="Parent account" htmlFor="account-parent">
          <Select id="account-parent" value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
            <option value="">Top level</option>
            {accounts
              .filter((entry) => entry.id !== account?.id)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} {entry.name}
                </option>
              ))}
          </Select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
            className="h-4 w-4 rounded border-ink-300 text-brand-700"
          />
          Active (available on new documents)
        </label>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor="account-description">
            <Textarea id="account-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
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

function TemplateModal({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: () => void }) {
  const { data } = useQuery<{ industries: string[] }>(open ? '/accounts/templates' : null);
  const [industry, setIndustry] = useState('services');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.post<{ created: number; skipped: number }>('/accounts/apply-template', { industry });
      setResult(outcome);
      onApplied();
      toast.success('Template applied', `${outcome.created} accounts added, ${outcome.skipped} already existed.`);
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
      title="Apply an industry template"
      description="Adds missing accounts for your industry. Existing accounts are never changed."
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={busy} onClick={() => void apply()}>
            Apply template
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Industry" htmlFor="template-industry">
          <Select id="template-industry" value={industry} onChange={(event) => setIndustry(event.target.value)}>
            {(data?.industries ?? ['services', 'retail', 'wholesale', 'construction', 'restaurant', 'nonprofit', 'technology']).map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="flex items-center gap-1 text-xs text-ink-500">
          <HelpTip text="Templates include industry-specific income, cost-of-goods and expense accounts. Applying one twice is safe.">
            How templates work
          </HelpTip>
        </p>
        {result && (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
            Added {result.created} accounts. {result.skipped} already existed.
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
