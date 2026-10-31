import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { download, errorMessage, toast, useDebounced, useQuery } from '../lib/data';
import { formatDate, formatMoney, titleCase, today, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
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
} from '../components/ui';

interface EntryRow {
  id: string;
  entry_no: number;
  date: string;
  memo: string | null;
  source_type: string;
  status: string;
  total: number;
  currency: string;
  reversal_of: string | null;
}

interface EntryDetail {
  entry: EntryRow;
  lines: Array<{ id: string; account_id: string; code: string; account_name: string; debit: number; credit: number; description: string | null }>;
}

interface Period {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface DraftLine {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

const emptyLine = (): DraftLine => ({ key: crypto.randomUUID(), accountId: '', debit: '', credit: '', description: '' });

export function JournalPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(params.get('new') === '1');
  const [confirmVoid, setConfirmVoid] = useState<EntryRow | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => ({ page, pageSize: 25, q: debounced || undefined, status }), [page, debounced, status]);
  const { data, loading, error, reload } = useQuery<{ data: EntryRow[]; pagination?: { total: number } }>('/journal-entries', query);
  const { data: detail, reload: reloadDetail } = useQuery<EntryDetail>(detailId ? `/journal-entries/${detailId}` : null);
  const { data: periods } = useQuery<{ data: Period[] }>('/periods');

  const rows = data?.data ?? [];

  const act = async (entry: EntryRow, action: 'reverse' | 'void') => {
    setBusy(true);
    try {
      await api.post(`/journal-entries/${entry.id}/${action}`, {});
      toast.success(action === 'reverse' ? 'Reversing entry created' : 'Entry voided');
      reload();
      if (detailId === entry.id) reloadDetail();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Journal"
        description="Every transaction in one immutable, double-entry ledger."
        actions={
          <>
            <Button variant="secondary" onClick={() => void download('/journal-entries/export', 'journal-entries.csv')}>
              Export CSV
            </Button>
            {can('journal:write') && (
              <Button
                variant="primary"
                onClick={() => {
                  setComposerOpen(true);
                  const next = new URLSearchParams(params);
                  next.delete('new');
                  setParams(next, { replace: true });
                }}
              >
                + New journal entry
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-ink-900">Entries</h2>
              <div className="flex items-center gap-2">
                <Select value={status} onChange={(event) => (setStatus(event.target.value), setPage(1))} aria-label="Entry status" className="w-36 py-1.5 text-xs">
                  {['all', 'posted', 'void', 'reversed'].map((option) => (
                    <option key={option} value={option}>
                      {titleCase(option)}
                    </option>
                  ))}
                </Select>
                <Input
                  data-search-input
                  value={search}
                  onChange={(event) => (setSearch(event.target.value), setPage(1))}
                  placeholder="Search memo or #"
                  aria-label="Search journal entries"
                  className="w-44 py-1.5 text-xs"
                />
              </div>
            </div>
            {loading && !data ? (
              <TableSkeleton rows={6} columns={5} />
            ) : error ? (
              <ErrorState message={error} onRetry={reload} />
            ) : rows.length === 0 ? (
              <EmptyState title="No journal entries" description="Post an invoice or record a manual adjustment to get started." />
            ) : (
              <>
                <Table caption="Journal entries">
                  <THead>
                    <tr>
                      <TH>#</TH>
                      <TH>Date</TH>
                      <TH>Memo</TH>
                      <TH>Source</TH>
                      <TH>Status</TH>
                      <TH numeric>Amount</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {rows.map((row) => (
                      <TR key={row.id} onClick={() => setDetailId(row.id)}>
                        <TD>{row.entry_no}</TD>
                        <TD>{formatDate(row.date, 'short')}</TD>
                        <TD className="max-w-64 truncate">{row.memo ?? '—'}</TD>
                        <TD className="capitalize text-xs text-ink-500">{row.source_type.replace(/_/g, ' ')}</TD>
                        <TD>
                          <StatusBadge status={row.status} />
                        </TD>
                        <TD numeric>
                          <Money amount={row.total} currency={row.currency || currency} />
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={page} pageSize={25} total={data?.pagination?.total ?? rows.length} onChange={setPage} />
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-ink-900">Periods</h2>
            <p className="mt-0.5 text-xs text-ink-500">Locked periods reject new postings.</p>
            <ul className="mt-3 space-y-2">
              {(periods?.data ?? []).slice(0, 4).map((period) => (
                <li key={period.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-ink-700">{period.name}</span>
                  <StatusBadge status={period.status === 'closed' ? 'void' : period.status === 'locked' ? 'excluded' : 'active'} label={titleCase(period.status)} />
                </li>
              ))}
              {!(periods?.data ?? []).length && <li className="text-xs text-ink-500">No periods generated yet.</li>}
            </ul>
            <a href="/settings?tab=periods" className="mt-3 inline-block text-xs font-semibold text-brand-800 hover:underline">
              Manage periods →
            </a>
          </Card>
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-ink-900">Ledger rules</h2>
            <ul className="mt-2 space-y-2 text-xs text-ink-600">
              <li>Debits must equal credits before an entry posts.</li>
              <li>Posted entries are never edited — they are reversed.</li>
              <li>Every entry writes an immutable audit record.</li>
              <li>Closing a period blocks back-dated postings.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Drawer
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
        title={detail ? `Entry #${detail.entry.entry_no}` : 'Journal entry'}
        description={detail ? `${formatDate(detail.entry.date)} · ${titleCase(detail.entry.source_type)}` : undefined}
        footer={
          detail && can('journal:write') && detail.entry.status === 'posted' ? (
            <>
              <Button variant="secondary" loading={busy} onClick={() => void act(detail.entry, 'reverse')}>
                Reverse
              </Button>
              <Button variant="ghost" className="text-red-700" loading={busy} onClick={() => setConfirmVoid(detail.entry)}>
                Void
              </Button>
            </>
          ) : undefined
        }
      >
        {!detail ? (
          <TableSkeleton rows={4} columns={4} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge status={detail.entry.status} />
              <span className="text-sm font-semibold">
                {formatMoney(detail.lines.reduce((sum, line) => sum + line.debit, 0), detail.entry.currency)}
              </span>
            </div>
            {detail.entry.memo && <p className="text-sm text-ink-600">{detail.entry.memo}</p>}
            <Table caption="Journal lines">
              <THead>
                <tr>
                  <TH>Account</TH>
                  <TH>Description</TH>
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                </tr>
              </THead>
              <tbody>
                {detail.lines.map((line) => (
                  <TR key={line.id}>
                    <TD>
                      <p className="font-medium text-ink-800">
                        {line.code} {line.account_name}
                      </p>
                    </TD>
                    <TD className="text-xs text-ink-500">{line.description ?? '—'}</TD>
                    <TD numeric>{line.debit ? formatMoney(line.debit, detail.entry.currency) : '—'}</TD>
                    <TD numeric>{line.credit ? formatMoney(line.credit, detail.entry.currency) : '—'}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            {detail.entry.reversal_of && <p className="text-xs text-ink-500">This entry reverses another entry.</p>}
          </div>
        )}
      </Drawer>

      <JournalComposer open={composerOpen} onClose={() => setComposerOpen(false)} currency={currency} onSaved={reload} />

      <ConfirmDialog
        open={confirmVoid !== null}
        title="Void this entry?"
        description="Voiding removes the entry from reports but keeps it in the ledger and audit trail."
        confirmLabel="Void entry"
        destructive
        onConfirm={async () => {
          if (confirmVoid) await act(confirmVoid, 'void');
          setConfirmVoid(null);
        }}
        onClose={() => setConfirmVoid(null)}
      />
    </>
  );
}

function JournalComposer({
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
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [sourceType, setSourceType] = useState('manual');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDate(today());
      setMemo('');
      setLines([emptyLine(), emptyLine()]);
      setError(null);
    }
  }, [open]);

  const totals = useMemo(() => {
    const debit = lines.reduce((sum, line) => sum + toMinor(line.debit), 0);
    const credit = lines.reduce((sum, line) => sum + toMinor(line.credit), 0);
    return { debit, credit, difference: debit - credit };
  }, [lines]);

  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async () => {
    setError(null);
    const prepared = lines
      .filter((line) => line.accountId && (toMinor(line.debit) > 0 || toMinor(line.credit) > 0))
      .map((line) => ({
        accountId: line.accountId,
        debit: toMinor(line.debit),
        credit: toMinor(line.credit),
        description: line.description || undefined,
      }));
    if (prepared.length < 2) {
      setError('A journal entry needs at least two lines.');
      return;
    }
    if (totals.debit !== totals.credit) {
      setError(`Debits (${formatMoney(totals.debit, currency)}) must equal credits (${formatMoney(totals.credit, currency)}).`);
      return;
    }
    setSaving(true);
    try {
      await api.post('/journal-entries', { date, memo: memo || undefined, sourceType, lines: prepared });
      toast.success('Journal entry posted', 'The ledger is updated.');
      onSaved();
      onClose();
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
      title="New journal entry"
      description="Use adjusting entries for accruals, depreciation and corrections."
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Post entry
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" htmlFor="je-date">
            <Input id="je-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Type" htmlFor="je-type">
            <Select id="je-type" value={sourceType} onChange={(event) => setSourceType(event.target.value)}>
              <option value="manual">Manual</option>
              <option value="adjusting">Adjusting</option>
              <option value="opening">Opening balance</option>
            </Select>
          </Field>
          <Field label="Memo" htmlFor="je-memo">
            <Input id="je-memo" value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Accrued rent, March" />
          </Field>
        </div>

        <div className="rounded-lg border border-ink-200">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2">
            <h3 className="text-sm font-semibold text-ink-900">Lines</h3>
            <Button size="sm" variant="ghost" onClick={() => setLines((current) => [...current, emptyLine()])}>
              + Add line
            </Button>
          </div>
          <div className="space-y-2 p-4">
            {lines.map((line, index) => (
              <div key={line.key} className="grid items-end gap-2 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <label className="label" htmlFor={`je-account-${line.key}`}>
                    Account {index + 1}
                  </label>
                  <Select id={`je-account-${line.key}`} value={line.accountId} onChange={(event) => update(line.key, { accountId: event.target.value })}>
                    <option value="">Select account…</option>
                    {(accountData?.data ?? []).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-3">
                  <label className="label" htmlFor={`je-desc-${line.key}`}>
                    Description
                  </label>
                  <Input id={`je-desc-${line.key}`} value={line.description} onChange={(event) => update(line.key, { description: event.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor={`je-debit-${line.key}`}>
                    Debit
                  </label>
                  <Input
                    id={`je-debit-${line.key}`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.debit}
                    onChange={(event) => update(line.key, { debit: event.target.value, credit: '' })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor={`je-credit-${line.key}`}>
                    Credit
                  </label>
                  <Input
                    id={`je-credit-${line.key}`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.credit}
                    onChange={(event) => update(line.key, { credit: event.target.value, debit: '' })}
                  />
                </div>
                <div className="sm:col-span-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-6 border-t border-ink-100 px-4 py-2 text-sm">
            <span className="text-ink-600">
              Debits <span className="ml-1 font-semibold text-ink-900">{formatMoney(totals.debit, currency)}</span>
            </span>
            <span className="text-ink-600">
              Credits <span className="ml-1 font-semibold text-ink-900">{formatMoney(totals.credit, currency)}</span>
            </span>
            <span className={totals.difference === 0 ? 'font-semibold text-brand-800' : 'font-semibold text-red-700'}>
              {totals.difference === 0 ? 'Balanced' : `Out by ${formatMoney(Math.abs(totals.difference), currency)}`}
            </span>
          </div>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
