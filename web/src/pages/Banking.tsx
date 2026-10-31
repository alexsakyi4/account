import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney, titleCase, today } from '../lib/format';
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
  Tabs,
  HelpTip,
} from '../components/ui';

interface BankAccount {
  id: string;
  name: string;
  bankName: string | null;
  mask: string | null;
  currency: string;
  accountId: string;
  glAccountName: string;
  balance: number;
  unmatched: number;
  lastImport: string | null;
  lastTransactionDate: string | null;
  provider: string;
}

interface Transaction {
  id: string;
  bank_account_id: string;
  date: string;
  description: string;
  payee: string | null;
  amount: number;
  currency: string;
  status: string;
  match_type: string | null;
  matched_entity_id: string | null;
  journal_entry_id: string | null;
  bank_account_name?: string;
}

interface Suggestion {
  type: 'payment' | 'invoice' | 'journal';
  id: string;
  label: string;
  amount: number;
  date: string;
  confidence: number;
}

interface Recon {
  reconciliation: {
    id: string;
    bank_account_id: string;
    end_date: string;
    statement_ending_balance: number;
    beginning_balance: number;
    status: string;
  };
  transactions: Array<Transaction & { cleared: number }>;
  summary: {
    beginningBalance: number;
    clearedTotal: number;
    computedBalance: number;
    statementEndingBalance: number;
    difference: number;
  };
}

interface Rule {
  id: string;
  name: string;
  match_field: string;
  match_op: string;
  match_value: string;
  target_type: string;
  target_account_id: string | null;
  auto_apply: number;
  is_active: number;
  priority: number;
}

const SAMPLE_CSV = `Date,Description,Amount\n${today()},ACME SUPPLIES INVOICE,-1250.00\n${today()},CUSTOMER DEPOSIT,3200.00`;

export function BankingPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [accountId, setAccountId] = useState<string>('');
  const [status, setStatus] = useState('unmatched');
  const [view, setView] = useState<'transactions' | 'reconcile' | 'rules'>('transactions');
  const [selected, setSelected] = useState<string[]>([]);
  const [matchTarget, setMatchTarget] = useState<Transaction | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const [startReconOpen, setStartReconOpen] = useState(false);
  const [reconId, setReconId] = useState<string | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: accountsData, loading: accountsLoading, reload: reloadAccounts } = useQuery<{ data: BankAccount[] }>('/banking/accounts');
  const accounts = accountsData?.data ?? [];

  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const account = accounts.find((entry) => entry.id === accountId);

  const txQuery = useMemo(
    () => ({ bankAccountId: accountId || undefined, status: status === 'all' ? undefined : status, pageSize: 100 }),
    [accountId, status],
  );
  const { data: txData, loading: txLoading, reload: reloadTx } = useQuery<{ data: Transaction[] }>(
    accountId && view === 'transactions' ? '/banking/transactions' : null,
    txQuery,
  );
  const { data: rulesData, reload: reloadRules } = useQuery<{ data: Rule[] }>(view === 'rules' ? '/banking/rules' : null);
  const { data: recon, reload: reloadRecon } = useQuery<Recon>(reconId ? `/banking/reconciliations/${reconId}` : null);

  const transactions = txData?.data ?? [];
  const allSelected = transactions.length > 0 && transactions.every((row) => selected.includes(row.id));

  const refreshAll = () => {
    reloadTx();
    reloadAccounts();
    if (reconId) reloadRecon();
  };

  const autoMatch = async () => {
    if (!accountId) return;
    setBusy(true);
    try {
      const result = await api.post<{ matched: number }>('/banking/auto-match', { bankAccountId: accountId });
      toast.success('Auto-match complete', `${result.matched ?? 0} statement lines matched.`);
      refreshAll();
    } catch (err) {
      toast.error('Auto-match failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bulkAction = async (action: 'exclude' | 'restore') => {
    setBusy(true);
    try {
      await api.post('/banking/transactions/bulk', { ids: selected, action });
      toast.success(action === 'exclude' ? 'Lines excluded' : 'Lines restored');
      setSelected([]);
      refreshAll();
    } catch (err) {
      toast.error('Bulk action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startRecon = async (endDate: string, statementEndingBalance: number) => {
    setBusy(true);
    try {
      const created = await api.post<{ id: string }>('/banking/reconciliations', {
        bankAccountId: accountId,
        endDate,
        statementEndingBalance,
      });
      setStartReconOpen(false);
      setView('reconcile');
      setReconId(created.id);
    } catch (err) {
      toast.error('Could not start reconciliation', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearLines = async (ids: string[], clearAllMatched = false) => {
    if (!reconId) return;
    setBusy(true);
    try {
      await api.post(`/banking/reconciliations/${reconId}/clear`, { transactionIds: ids, clearAllMatched });
      reloadRecon();
      reloadTx();
    } catch (err) {
      toast.error('Could not clear lines', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const completeRecon = async () => {
    if (!reconId) return;
    setBusy(true);
    try {
      await api.post(`/banking/reconciliations/${reconId}/complete`, {});
      toast.success('Reconciliation complete', 'The period is locked for these statement lines.');
      setReconId(null);
      setView('transactions');
      refreshAll();
    } catch (err) {
      toast.error('Cannot complete yet', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (accountsLoading && !accountsData) {
    return <TableSkeleton rows={4} columns={4} />;
  }

  return (
    <>
      <PageHeader
        title="Banking"
        description="Import statements, match transactions and reconcile to the penny."
        actions={
          <>
            {can('banking:write') && (
              <>
                <Button variant="secondary" onClick={() => setNewAccountOpen(true)}>
                  Link account
                </Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={!accountId}>
                  Import statement
                </Button>
                <Button variant="primary" onClick={() => void autoMatch()} loading={busy} disabled={!accountId}>
                  Auto-match
                </Button>
              </>
            )}
          </>
        }
      />

      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            title="No bank accounts linked"
            description="Link a general ledger bank account, then import a CSV statement to start reconciling."
            action={
              can('banking:write') ? (
                <Button variant="primary" onClick={() => setNewAccountOpen(true)}>
                  Link a bank account
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {accounts.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  setAccountId(entry.id);
                  setView('transactions');
                  setReconId(null);
                }}
                className={`card p-5 text-left transition ${ entry.id === accountId ? 'ring-2 ring-brand-600' : 'hover:border-ink-300' }`}
                aria-pressed={entry.id === accountId}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{entry.name}</p>
                    <p className="text-xs text-ink-500">
                      {entry.bankName ?? 'Manual account'}
                      {entry.mask ? ` •••• ${entry.mask}` : ''} · {entry.glAccountName}
                    </p>
                  </div>
                  <span className="badge bg-ink-100 capitalize text-ink-600">{entry.provider}</span>
                </div>
                <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatMoney(entry.balance, entry.currency)}</p>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-ink-500">{entry.lastTransactionDate ? `Last txn ${formatDate(entry.lastTransactionDate, 'short')}` : 'No transactions yet'}</span>
                  {entry.unmatched > 0 ? (
                    <span className="badge bg-amber-100 text-amber-800">{entry.unmatched} to review</span>
                  ) : (
                    <span className="badge bg-brand-100 text-brand-800">All matched</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-ink-200 px-4 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs
                ariaLabel="Banking views"
                value={view}
                onChange={(value) => setView(value as 'transactions' | 'reconcile' | 'rules')}
                tabs={[
                  { id: 'transactions', label: 'Statement lines' },
                  { id: 'reconcile', label: 'Reconcile', disabled: !reconId },
                  { id: 'rules', label: 'Rules' },
                ]}
              />
              {view === 'transactions' && (
                <div className="flex items-center gap-2 pb-2">
                  <Select value={status} onChange={(event) => (setStatus(event.target.value), setSelected([]))} aria-label="Filter statement lines" className="w-40 py-1.5 text-xs">
                    <option value="unmatched">To review</option>
                    <option value="matched">Matched</option>
                    <option value="reconciled">Reconciled</option>
                    <option value="excluded">Excluded</option>
                    <option value="all">All</option>
                  </Select>
                  {can('banking:write') && (
                    <Button size="sm" variant="secondary" onClick={() => setStartReconOpen(true)}>
                      Reconcile
                    </Button>
                  )}
                </div>
              )}
              {view === 'rules' && can('banking:write') && (
                <Button size="sm" className="mb-2" onClick={() => setRuleOpen(true)}>
                  + New rule
                </Button>
              )}
            </div>

            {view === 'transactions' && (
              <>
                {selected.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-brand-50 px-4 py-2 text-sm">
                    <span className="font-medium text-brand-900">{selected.length} selected</span>
                    <Button size="sm" onClick={() => void bulkAction('exclude')}>
                      Exclude
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void bulkAction('restore')}>
                      Restore
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  </div>
                )}
                {txLoading && !txData ? (
                  <TableSkeleton rows={6} columns={5} />
                ) : transactions.length === 0 ? (
                  <EmptyState
                    title={status === 'unmatched' ? 'Nothing to review' : 'No statement lines'}
                    description="Import a CSV from your bank, or connect a live feed to pull transactions automatically."
                    action={
                      <Button variant="secondary" onClick={() => setImportOpen(true)}>
                        Import statement
                      </Button>
                    }
                  />
                ) : (
                  <Table caption="Bank transactions">
                    <THead>
                      <tr>
                        <th scope="col" className="th w-10">
                          <input
                            type="checkbox"
                            aria-label="Select all lines"
                            checked={allSelected}
                            onChange={(event) => setSelected(event.target.checked ? transactions.map((row) => row.id) : [])}
                            className="h-4 w-4 rounded border-ink-300 text-brand-700"
                          />
                        </th>
                        <TH>Date</TH>
                        <TH>Description</TH>
                        <TH>Status</TH>
                        <TH numeric>Amount</TH>
                        <TH>Action</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {transactions.map((row) => (
                        <TR key={row.id} selected={selected.includes(row.id)}>
                          <TD>
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.description}`}
                              checked={selected.includes(row.id)}
                              onChange={(event) =>
                                setSelected((current) => (event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id)))
                              }
                              className="h-4 w-4 rounded border-ink-300 text-brand-700"
                            />
                          </TD>
                          <TD>{formatDate(row.date, 'short')}</TD>
                          <TD>
                            <p className="font-medium text-ink-800">{row.description}</p>
                            {row.payee && <p className="text-xs text-ink-500">{row.payee}</p>}
                          </TD>
                          <TD>
                            <StatusBadge status={row.status} />
                          </TD>
                          <TD numeric>
                            <span className={row.amount < 0 ? 'text-red-700' : 'text-brand-800'}>{formatMoney(row.amount, row.currency)}</span>
                          </TD>
                          <TD>
                            {row.status === 'unmatched' && can('banking:write') && (
                              <Button size="sm" variant="ghost" onClick={() => setMatchTarget(row)}>
                                Match
                              </Button>
                            )}
                            {row.status === 'matched' && <span className="text-xs text-ink-500">{titleCase(row.match_type ?? '')}</span>}
                          </TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                )}
              </>
            )}

            {view === 'reconcile' && reconId && (
              <div className="p-5">
                {!recon ? (
                  <TableSkeleton rows={4} columns={3} />
                ) : (
                  <div className="space-y-5">
                    <div className="grid gap-4 sm:grid-cols-4">
                      <div className="rounded-lg bg-ink-50 p-3">
                        <p className="text-xs text-ink-500">Beginning balance</p>
                        <p className="text-lg font-semibold">{formatMoney(recon.summary.beginningBalance, currency)}</p>
                      </div>
                      <div className="rounded-lg bg-ink-50 p-3">
                        <p className="text-xs text-ink-500">Cleared</p>
                        <p className="text-lg font-semibold">{formatMoney(recon.summary.clearedTotal, currency)}</p>
                      </div>
                      <div className="rounded-lg bg-ink-50 p-3">
                        <p className="text-xs text-ink-500">Statement ending</p>
                        <p className="text-lg font-semibold">{formatMoney(recon.summary.statementEndingBalance, currency)}</p>
                      </div>
                      <div className={`rounded-lg p-3 ${ recon.summary.difference === 0 ? 'bg-brand-50' : 'bg-amber-50' }`}>
                        <p className="text-xs text-ink-500">Difference</p>
                        <p className={`text-lg font-semibold ${ recon.summary.difference === 0 ? 'text-brand-800' : 'text-amber-800' }`}>
                          {formatMoney(recon.summary.difference, currency)}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() => void clearLines([], true)}
                      >
                        Clear all matched
                      </Button>
                      <Button
                        variant="primary"
                        disabled={recon.summary.difference !== 0}
                        loading={busy}
                        onClick={() => void completeRecon()}
                      >
                        Complete reconciliation
                      </Button>
                      <Button variant="ghost" onClick={() => { setReconId(null); setView('transactions'); }}>
                        Close without finishing
                      </Button>
                      {recon.summary.difference !== 0 && (
                        <span className="text-xs text-amber-800">Clear lines until the difference is zero to finish.</span>
                      )}
                    </div>
                    <Table caption="Reconciliation lines">
                      <THead>
                        <tr>
                          <TH>Date</TH>
                          <TH>Description</TH>
                          <TH numeric>Amount</TH>
                          <TH>Cleared</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {recon.transactions.map((row) => (
                          <TR key={row.id}>
                            <TD>{formatDate(row.date, 'short')}</TD>
                            <TD>{row.description}</TD>
                            <TD numeric>{formatMoney(row.amount, row.currency)}</TD>
                            <TD>
                              {row.cleared ? (
                                <StatusBadge status="matched" label="Cleared" />
                              ) : (
                                <input
                                  type="checkbox"
                                  aria-label={`Clear ${row.description}`}
                                  onChange={(event) => event.target.checked && void clearLines([row.id])}
                                  className="h-4 w-4"
                                />
                              )}
                            </TD>
                          </TR>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            {view === 'rules' && (
              <Table caption="Bank rules">
                <THead>
                  <tr>
                    <TH>Rule</TH>
                    <TH>Match</TH>
                    <TH>Target</TH>
                    <TH>Auto apply</TH>
                    <TH>Priority</TH>
                  </tr>
                </THead>
                <tbody>
                  {(rulesData?.data ?? []).map((rule) => (
                    <TR key={rule.id}>
                      <TD>{rule.name}</TD>
                      <TD>
                        {rule.match_field} {rule.match_op.replace(/_/g, ' ')} “{rule.match_value}”
                      </TD>
                      <TD>{rule.target_type === 'exclude' ? 'Exclude from books' : 'Journal entry'}</TD>
                      <TD>{rule.auto_apply ? 'Yes' : 'Suggest only'}</TD>
                      <TD>{rule.priority}</TD>
                    </TR>
                  ))}
                  {!rulesData?.data.length && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-500">
                        No rules yet. Rules categorise recurring payments automatically.
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      <ImportStatementModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        accountId={accountId}
        onImported={() => {
          setImportOpen(false);
          refreshAll();
        }}
      />

      <NewBankAccountModal open={newAccountOpen} onClose={() => setNewAccountOpen(false)} onCreated={reloadAccounts} />

      <StartReconModal open={startReconOpen} onClose={() => setStartReconOpen(false)} onStart={startRecon} busy={busy} currency={currency} />

      <MatchModal
        transaction={matchTarget}
        onClose={() => setMatchTarget(null)}
        onMatched={() => {
          setMatchTarget(null);
          refreshAll();
        }}
      />

      <RuleModal
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        onSaved={() => {
          setRuleOpen(false);
          reloadRules();
        }}
      />
    </>
  );
}

function ImportStatementModal({
  open,
  onClose,
  accountId,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  onImported: () => void;
}): React.JSX.Element {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ imported: number; duplicates: number }>(`/banking/accounts/${accountId}/import`, { csv });
      toast.success('Statement imported', `${result.imported} lines added${result.duplicates ? `, ${result.duplicates} duplicates skipped` : ''}.`);
      setCsv('');
      onImported();
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
      title="Import a bank statement"
      description="CSV with date, description and amount (or debit/credit). Duplicates are skipped automatically."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!csv.trim()}>
            Import lines
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setCsv(await file.text());
            }}
          />
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            Choose CSV file
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCsv(SAMPLE_CSV)}>
            Insert sample
          </Button>
        </div>
        <Field label="Statement CSV" htmlFor="statement-csv" hint="Nothing is imported until you confirm; duplicates are matched on date, amount and description.">
          <textarea
            id="statement-csv"
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            className="input min-h-40 font-mono text-xs"
            placeholder="Date,Description,Amount"
          />
        </Field>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function NewBankAccountModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mask, setMask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: accounts } = useQuery<{ data: Array<{ id: string; code: string; name: string; type: string; subtype: string | null }> }>(open ? '/accounts?pageSize=300' : null);
  const candidates = (accounts?.data ?? []).filter((account) => account.type === 'asset' && (account.subtype === 'bank' || account.subtype === 'cash'));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/banking/accounts', { name, accountId, bankName: bankName || undefined, mask: mask || undefined });
      toast.success('Bank account linked');
      onCreated();
      onClose();
      setName('');
      setBankName('');
      setMask('');
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
      title="Link a bank account"
      description="Pick the general ledger account this statement belongs to."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} disabled={!accountId || !name}>
            Link account
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" required htmlFor="bank-name">
          <Input id="bank-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Operating account" />
        </Field>
        <Field label="Bank" htmlFor="bank-institution">
          <Input id="bank-institution" value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="First National" />
        </Field>
        <Field label="GL account" required htmlFor="bank-gl">
          <Select id="bank-gl" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Select account…</option>
            {candidates.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Last 4 digits" htmlFor="bank-mask">
          <Input id="bank-mask" value={mask} onChange={(event) => setMask(event.target.value)} maxLength={4} />
        </Field>
        {error && (
          <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function StartReconModal({
  open,
  onClose,
  onStart,
  busy,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  onStart: (endDate: string, statementEndingBalance: number) => void;
  busy: boolean;
  currency: string;
}): React.JSX.Element {
  const [endDate, setEndDate] = useState(today());
  const [balance, setBalance] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a reconciliation"
      description="Enter the ending balance from your bank statement. Clear lines until the difference is zero."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => onStart(endDate, Math.round(Number.parseFloat(balance || '0') * 100))}>
            Start
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Statement end date" htmlFor="recon-date">
          <Input id="recon-date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </Field>
        <Field label={`Statement ending balance (${currency})`} htmlFor="recon-balance">
          <Input id="recon-balance" inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder="0.00" />
        </Field>
      </div>
    </Modal>
  );
}

function MatchModal({
  transaction,
  onClose,
  onMatched,
}: {
  transaction: Transaction | null;
  onClose: () => void;
  onMatched: () => void;
}): React.JSX.Element {
  const { data: suggestions, loading } = useQuery<{ suggestions: Suggestion[] }>(
    transaction ? `/banking/transactions/${transaction.id}/suggestions` : null,
  );
  const [manualAccount, setManualAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: accounts } = useQuery<{ data: Array<{ id: string; code: string; name: string; type: string }> }>(
    transaction ? '/accounts?pageSize=300' : null,
  );

  const match = async (payload: { type: 'payment' | 'journal' | 'exclude'; targetId?: string; accountId?: string }) => {
    if (!transaction) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/banking/transactions/${transaction.id}/match`, payload);
      toast.success('Transaction matched');
      onMatched();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(transaction)}
      onClose={onClose}
      title="Match transaction"
      description={transaction ? `${transaction.description} · ${formatMoney(transaction.amount, transaction.currency)}` : ''}
      size="lg"
    >
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Suggestions</h3>
          {loading ? (
            <TableSkeleton rows={2} columns={2} />
          ) : (suggestions?.suggestions ?? []).length === 0 ? (
            <p className="text-sm text-ink-500">No automatic suggestions. Categorise it to an account below.</p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
              {(suggestions?.suggestions ?? []).map((suggestion) => (
                <li key={suggestion.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink-800">{suggestion.label}</p>
                    <p className="text-xs text-ink-500">
                      {titleCase(suggestion.type)} · {formatDate(suggestion.date, 'short')} · {Math.round(suggestion.confidence * 100)}% match
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() => void match({ type: suggestion.type === 'invoice' ? 'payment' : suggestion.type, targetId: suggestion.id })}
                  >
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-ink-200 p-4">
          <h3 className="text-sm font-semibold text-ink-900">Categorise to an account</h3>
          <p className="mt-0.5 text-xs text-ink-500">Creates a journal entry: bank account against the chosen category.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <label className="label" htmlFor="match-account">
                Account
              </label>
              <Select id="match-account" value={manualAccount} onChange={(event) => setManualAccount(event.target.value)}>
                <option value="">Select…</option>
                {(accounts?.data ?? []).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="secondary" loading={busy} disabled={!manualAccount} onClick={() => void match({ type: 'journal', accountId: manualAccount })}>
              Categorise
            </Button>
            <Button variant="ghost" loading={busy} onClick={() => void match({ type: 'exclude' })}>
              Exclude from books
            </Button>
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

function RuleModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [matchField, setMatchField] = useState('description');
  const [matchOp, setMatchOp] = useState('contains');
  const [matchValue, setMatchValue] = useState('');
  const [targetType, setTargetType] = useState('journal');
  const [targetAccountId, setTargetAccountId] = useState('');
  const [autoApply, setAutoApply] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: accounts } = useQuery<{ data: Array<{ id: string; code: string; name: string }> }>(open ? '/accounts?pageSize=300' : null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/banking/rules', {
        name,
        matchField,
        matchOp,
        matchValue,
        targetType,
        targetAccountId: targetType === 'journal' ? targetAccountId : null,
        autoApply,
      });
      toast.success('Rule saved');
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
      title="New bank rule"
      description="Rules categorise recurring statement lines automatically or suggest a match."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Rule name" required htmlFor="rule-name">
          <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Stripe payouts" />
        </Field>
        <Field label="Match value" required htmlFor="rule-value">
          <Input id="rule-value" value={matchValue} onChange={(event) => setMatchValue(event.target.value)} placeholder="STRIPE" />
        </Field>
        <Field label="Match field" htmlFor="rule-field">
          <Select id="rule-field" value={matchField} onChange={(event) => setMatchField(event.target.value)}>
            {['description', 'payee', 'amount'].map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Condition" htmlFor="rule-op">
          <Select id="rule-op" value={matchOp} onChange={(event) => setMatchOp(event.target.value)}>
            {['contains', 'equals', 'starts_with'].map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target" htmlFor="rule-target">
          <Select id="rule-target" value={targetType} onChange={(event) => setTargetType(event.target.value)}>
            <option value="journal">Categorise to account</option>
            <option value="exclude">Exclude from books</option>
          </Select>
        </Field>
        {targetType === 'journal' && (
          <Field label="Account" required htmlFor="rule-account">
            <Select id="rule-account" value={targetAccountId} onChange={(event) => setTargetAccountId(event.target.value)}>
              <option value="">Select…</option>
              {(accounts?.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} {account.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <label className="sm:col-span-2 flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={autoApply} onChange={(event) => setAutoApply(event.target.checked)} className="h-4 w-4 rounded border-ink-300 text-brand-700" />
          Apply automatically during auto-match
        </label>
        {error && (
          <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
