import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { download, errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney, startOfMonth, startOfYear, today, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  TableSkeleton,
} from '../components/ui';

interface Definition {
  id: string;
  name: string;
  group: string;
  needsRange: boolean;
  needsAccount?: boolean;
}

interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  amount: number;
  depth?: number;
  meta?: { debit?: number; credit?: number };
}

interface Report {
  report: string;
  title: string;
  from: string | null;
  to: string;
  currency: string;
  generatedAt: string;
  sections: Array<{ key: string; label: string; lines: ReportLine[]; total: number }>;
  totals: Record<string, number>;
  meta?: Record<string, unknown>;
}

interface Schedule {
  id: string;
  name: string;
  report_type: string;
  frequency: string;
  recipients: string;
  format: string;
  next_run_at: string;
  last_run_at: string | null;
  status: string;
}

export function ReportsPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState(params.get('type') ?? 'profit-and-loss');
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const { data: definitions } = useQuery<{ reports: Definition[] }>('/reports/definitions');
  const { data: accountData } = useQuery<{ data: Array<{ id: string; code: string; name: string }> }>('/accounts?pageSize=300');
  const definition = definitions?.reports.find((entry) => entry.id === type);
  const needsRange = definition?.needsRange ?? true;
  const needsAccount = definition?.needsAccount ?? false;

  const query = useMemo(
    () => ({ from: needsRange ? from : undefined, to, accountId: needsAccount && accountId ? accountId : undefined }),
    [from, to, needsRange, needsAccount, accountId],
  );
  const { data: report, loading, error, reload } = useQuery<Report>(`/reports/${type}`, query);
  const { data: schedules, reload: reloadSchedules } = useQuery<{ data: Schedule[] }>('/reports/schedules/list');

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (type === 'profit-and-loss') next.delete('type');
    else next.set('type', type);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const groups = useMemo(() => {
    const map = new Map<string, Definition[]>();
    for (const entry of definitions?.reports ?? []) {
      map.set(entry.group, [...(map.get(entry.group) ?? []), entry]);
    }
    return [...map.entries()];
  }, [definitions]);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Financial statements and analysis, always in balance with the ledger."
        actions={
          <>
            {can('reports:read') && (
              <Button variant="secondary" onClick={() => setScheduleOpen(true)}>
                Schedule email
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => void download(`/reports/${type}/export?format=csv&from=${from}&to=${to}${accountId ? `&accountId=${accountId}` : ''}`, `${type}-${to}.csv`)}
            >
              Export CSV
            </Button>
            <Button variant="secondary" onClick={() => window.print()}>
              Print / PDF
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside aria-label="Report types" className="space-y-4">
          <Card className="p-2 print:hidden">
            {groups.map(([group, entries]) => (
              <div key={group} className="mb-2">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{group}</p>
                <ul className="space-y-0.5">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        onClick={() => setType(entry.id)}
                        aria-current={type === entry.id ? 'true' : undefined}
                        className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm ${
                          type === entry.id ? 'bg-brand-50 font-semibold text-brand-900' : 'text-ink-600 hover:bg-ink-100'
                        }`}
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>

          <Card className="p-4 print:hidden">
            <h2 className="text-sm font-semibold text-ink-900">Parameters</h2>
            <div className="mt-3 space-y-3">
              {needsRange && (
                <>
                  <Field label="From" htmlFor="report-from">
                    <Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                  </Field>
                  <Field label="To" htmlFor="report-to">
                    <Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                  </Field>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => { setFrom(startOfMonth()); setTo(today()); }}>
                      This month
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setFrom(startOfYear()); setTo(today()); }}>
                      Year to date
                    </Button>
                  </div>
                </>
              )}
              {!needsRange && (
                <Field label="As of" htmlFor="report-asof">
                  <Input id="report-asof" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                </Field>
              )}
              {needsAccount && (
                <Field label="Account" htmlFor="report-account">
                  <Select id="report-account" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                    <option value="">All accounts</option>
                    {(accountData?.data ?? []).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          </Card>

          {(schedules?.data ?? []).length > 0 && (
            <Card className="p-4 print:hidden">
              <h2 className="text-sm font-semibold text-ink-900">Scheduled</h2>
              <ul className="mt-2 space-y-2 text-xs">
                {(schedules?.data ?? []).map((schedule) => (
                  <li key={schedule.id} className="rounded-md bg-ink-50 px-2 py-1.5">
                    <p className="font-medium text-ink-800">{schedule.name}</p>
                    <p className="text-ink-500">
                      {titleCase(schedule.frequency)} · next {formatDate(schedule.next_run_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>

        <Card className="min-h-[520px] overflow-hidden">
          {loading && !report ? (
            <TableSkeleton rows={8} columns={3} />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : !report ? (
            <EmptyState title="Run a report" description="Choose a report on the left and adjust the dates." />
          ) : (
            <article aria-label={report.title}>
              <header className="border-b border-ink-100 px-6 py-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">{session?.tenant.name}</p>
                <h2 className="mt-1 text-xl font-semibold text-ink-900">{report.title}</h2>
                <p className="mt-0.5 text-xs text-ink-500">
                  {report.from ? `${formatDate(report.from)} – ${formatDate(report.to)}` : `As of ${formatDate(report.to)}`} ·{' '}
                  {report.currency} · accrual basis · generated {formatDate(report.generatedAt.slice(0, 10))}
                </p>
              </header>

              <div className="divide-y divide-ink-100">
                {report.sections.map((section) => (
                  <section key={section.key} className="px-6 py-4">
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-sm font-semibold text-ink-900">{section.label}</h3>
                      {section.key === 'accounts' && report.totals.debit !== undefined && (
                        <span className="text-xs text-ink-500">
                          Debits {formatMoney(report.totals.debit, report.currency)} · Credits {formatMoney(report.totals.credit ?? 0, report.currency)}
                        </span>
                      )}
                    </div>
                    {section.lines.length === 0 ? (
                      <p className="mt-2 text-xs text-ink-500">No activity in this period.</p>
                    ) : (
                      <table className="mt-2 w-full">
                        <caption className="sr-only">{section.label}</caption>
                        <tbody>
                          {section.lines.map((line) => (
                            <tr key={`${section.key}-${line.accountId}-${line.code}`} className="border-b border-ink-50 last:border-0">
                              <td className="py-1.5 pr-2 text-sm text-ink-700" style={{ paddingLeft: `${(line.depth ?? 0) * 12}px` }}>
                                {line.code && <span className="mr-2 text-xs tabular-nums text-ink-400">{line.code}</span>}
                                {line.name}
                              </td>
                              {line.meta?.debit !== undefined && (
                                <>
                                  <td className="w-28 py-1.5 text-right text-sm tabular-nums text-ink-600">
                                    {line.meta.debit ? formatMoney(line.meta.debit, report.currency) : ''}
                                  </td>
                                  <td className="w-28 py-1.5 text-right text-sm tabular-nums text-ink-600">
                                    {line.meta.credit ? formatMoney(line.meta.credit, report.currency) : ''}
                                  </td>
                                </>
                              )}
                              {line.meta?.debit === undefined && (
                                <td className="w-32 py-1.5 text-right text-sm tabular-nums text-ink-800">
                                  {formatMoney(line.amount, report.currency)}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {section.total !== 0 && (
                      <div className="mt-2 flex justify-between border-t border-ink-200 pt-1.5 text-sm font-semibold text-ink-900">
                        <span>Total {section.label.toLowerCase()}</span>
                        <span className="tabular-nums">{formatMoney(section.total, report.currency)}</span>
                      </div>
                    )}
                  </section>
                ))}
              </div>

              {Object.keys(report.totals).length > 0 && (
                <footer className="grid gap-3 border-t border-ink-200 bg-ink-50 px-6 py-4 sm:grid-cols-3">
                  {Object.entries(report.totals)
                    .filter(([key]) => key !== 'debit' && key !== 'credit')
                    .map(([key, value]) => (
                      <div key={key}>
                        <p className="text-xs uppercase tracking-wide text-ink-500">{titleCase(key)}</p>
                        <p className="text-lg font-semibold tabular-nums text-ink-900">{formatMoney(value, report.currency)}</p>
                      </div>
                    ))}
                </footer>
              )}
            </article>
          )}
        </Card>
      </div>

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        reportType={type}
        reportName={definition?.name ?? titleCase(type)}
        from={from}
        to={to}
        onSaved={() => {
          setScheduleOpen(false);
          reloadSchedules();
        }}
      />
    </>
  );
}

function ScheduleModal({
  open,
  onClose,
  reportType,
  reportName,
  from,
  to,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  reportType: string;
  reportName: string;
  from: string;
  to: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(`${reportName} — scheduled`);
  const [frequency, setFrequency] = useState('monthly');
  const [recipients, setRecipients] = useState('');
  const [format, setFormat] = useState('csv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/reports/schedules', { reportType, name, frequency, recipients, format, from, to });
      toast.success('Report scheduled', 'The first delivery is queued by the background worker.');
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
      title="Schedule this report"
      description="Delivered by email as a CSV or PDF attachment."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Schedule name" required htmlFor="schedule-name">
          <Input id="schedule-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Frequency" htmlFor="schedule-frequency">
          <Select id="schedule-frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)}>
            {['weekly', 'monthly', 'quarterly'].map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Recipients" required htmlFor="schedule-recipients" hint="Comma-separated email addresses.">
          <Input id="schedule-recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="owner@company.com" />
        </Field>
        <Field label="Format" htmlFor="schedule-format">
          <Select id="schedule-format" value={format} onChange={(event) => setFormat(event.target.value)}>
            <option value="csv">CSV</option>
            <option value="pdf">PDF</option>
          </Select>
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
