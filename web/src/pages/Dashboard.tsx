import { Link } from 'react-router-dom';
import { useQuery } from '../lib/data';
import { formatDate, formatDateTime, formatMoney, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import {
  BarChart,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Money,
  PageHeader,
  ProgressBar,
  StatCard,
  StatusBadge,
  Table,
  TD,
  TH,
  THead,
  TR,
  TableSkeleton,
} from '../components/ui';

interface DashboardData {
  asOf: string;
  cash: { amount: number; label: string };
  receivables: { amount: number; overdue: number };
  payables: { amount: number; overdue: number };
  month: { income: number; expenses: number; netIncome: number };
  year: { income: number; expenses: number; netIncome: number };
  balanceSheet: { assets: number; liabilities: number; equity: number };
  trend: Array<{ month: string; income: number; expenses: number; net: number }>;
  overdueInvoices: Array<{ id: string; number: string; contact_name: string; due_date: string; balance: number; currency: string }>;
  recentEntries: Array<{ id: string; source_type: string; date: string; memo: string; entry_no: number }>;
  counts: { customers: number; vendors: number; invoices: number; bills: number };
}

interface OnboardingData {
  completed: number;
  data: Array<{ step_key: string; completed_at: string | null }>;
}

const STEP_LABELS: Record<string, string> = {
  company: 'Company details',
  accounts: 'Review chart of accounts',
  bank: 'Connect or import a bank statement',
  customers: 'Add a customer or vendor',
  invoice: 'Create your first invoice',
  expenses: 'Record a bill or expense',
  reconcile: 'Reconcile the bank account',
  reports: 'Run a report',
};

export function DashboardPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const { data, loading, error, reload } = useQuery<DashboardData>('/reports/dashboard');
  const { data: onboarding } = useQuery<OnboardingData>('/onboarding');

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" description="Your cash position, receivables and month at a glance." />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  const steps = onboarding?.data ?? [];
  const completedSteps = onboarding?.completed ?? 0;
  const nextStep = steps.find((step) => !step.completed_at);

  return (
    <>
      <PageHeader
        title={`Good to see you, ${session?.user.name.split(' ')[0] ?? 'there'}`}
        description={`${session?.tenant.name} · as of ${formatDate(data?.asOf)}`}
        actions={
          <>
            {can('invoices:write') && (
              <Link to="/invoices?new=1" className="btn-primary">
                New invoice
              </Link>
            )}
            {can('bills:write') && (
              <Link to="/bills?new=1" className="btn-secondary">
                New bill
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading && !data
          ? Array.from({ length: 4 }).map((_, index) => <div key={index} className="card h-28 animate-pulse" />)
          : [
              {
                label: 'Cash and bank',
                value: <Money amount={data?.cash.amount ?? 0} currency={currency} />,
                hint: 'Across all bank and cash accounts',
              },
              {
                label: 'Receivables',
                value: <Money amount={data?.receivables.amount ?? 0} currency={currency} />,
                hint: data?.receivables.overdue ? `${formatMoney(data.receivables.overdue, currency)} overdue` : 'Nothing overdue',
                tone: data?.receivables.overdue ? ('warning' as const) : ('default' as const),
              },
              {
                label: 'Payables',
                value: <Money amount={data?.payables.amount ?? 0} currency={currency} />,
                hint: data?.payables.overdue ? `${formatMoney(data.payables.overdue, currency)} overdue` : 'Nothing overdue',
                tone: data?.payables.overdue ? ('warning' as const) : ('default' as const),
              },
              {
                label: 'Net profit (year to date)',
                value: <Money amount={data?.year.netIncome ?? 0} currency={currency} colored />,
                hint: `${formatMoney(data?.year.income ?? 0, currency)} income · ${formatMoney(data?.year.expenses ?? 0, currency)} expenses`,
              },
            ].map((stat) => (
              <StatCard key={stat.label} label={stat.label} value={stat.value} hint={stat.hint} tone={stat.tone} />
            ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Income vs expenses"
            description="Last six months, accrual basis"
            action={
              <Link to="/reports?type=profit-and-loss" className="text-xs font-semibold text-brand-800 hover:underline">
                Open P&amp;L
              </Link>
            }
          />
          <div className="p-5">
            {loading && !data ? (
              <div className="skeleton h-40 w-full" />
            ) : (
              <BarChart
                currency={currency}
                series={(data?.trend ?? []).map((point) => ({ label: point.month, income: point.income, expenses: point.expenses }))}
              />
            )}
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-ink-100 pt-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-500">Income this month</dt>
                <dd className="text-sm font-semibold text-ink-900">
                  <Money amount={data?.month.income ?? 0} currency={currency} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Expenses this month</dt>
                <dd className="text-sm font-semibold text-ink-900">
                  <Money amount={data?.month.expenses ?? 0} currency={currency} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Net this month</dt>
                <dd className="text-sm font-semibold text-brand-800">
                  <Money amount={data?.month.netIncome ?? 0} currency={currency} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Equity</dt>
                <dd className="text-sm font-semibold text-ink-900">
                  <Money amount={data?.balanceSheet.equity ?? 0} currency={currency} />
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card>
          <CardHeader title="Set-up checklist" description={nextStep ? STEP_LABELS[nextStep.step_key] ?? nextStep.step_key : 'All done'} />
          <div className="p-5">
            <ProgressBar value={completedSteps} max={Math.max(steps.length, 1)} label="Setup progress" />
            <ul className="mt-4 space-y-2">
              {steps.slice(0, 5).map((step) => (
                <li key={step.step_key} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={
                      step.completed_at
                        ? 'flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 text-[10px] text-brand-800'
                        : 'flex h-4 w-4 items-center justify-center rounded-full border border-ink-300 text-[10px] text-ink-400'
                    }
                  >
                    {step.completed_at ? '✓' : ''}
                  </span>
                  <span className={step.completed_at ? 'text-ink-500 line-through' : 'text-ink-800'}>
                    {STEP_LABELS[step.step_key] ?? step.step_key}
                  </span>
                </li>
              ))}
            </ul>
            <Link to="/onboarding" className="mt-4 inline-block text-sm font-semibold text-brand-800 hover:underline">
              {completedSteps === steps.length ? 'Review setup' : 'Continue setup'} →
            </Link>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader
            title="Overdue invoices"
            description={data?.overdueInvoices.length ? `${data?.overdueInvoices.length} awaiting collection` : 'Nothing overdue — nice work'}
            action={
              <Link to="/invoices?status=overdue" className="text-xs font-semibold text-brand-800 hover:underline">
                View all
              </Link>
            }
          />
          {loading && !data ? (
            <TableSkeleton rows={3} columns={4} />
          ) : data?.overdueInvoices.length ? (
            <Table caption="Overdue invoices">
              <THead>
                <tr>
                  <TH>Invoice</TH>
                  <TH>Customer</TH>
                  <TH>Due</TH>
                  <TH numeric>Balance</TH>
                </tr>
              </THead>
              <tbody>
                {data.overdueInvoices.map((invoice) => (
                  <TR key={invoice.id}>
                    <TD>
                      <Link to={`/invoices?focus=${invoice.id}`} className="font-medium text-ink-900 hover:underline">
                        {invoice.number}
                      </Link>
                    </TD>
                    <TD>{invoice.contact_name}</TD>
                    <TD>
                      <span className="text-red-700">{formatDate(invoice.due_date)}</span>
                    </TD>
                    <TD numeric>
                      <Money amount={invoice.balance} currency={invoice.currency} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="px-5 py-10 text-center text-sm text-ink-500">No overdue invoices.</p>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Recent activity" description="Posted journal entries" />
          <ul className="divide-y divide-ink-100">
            {(data?.recentEntries ?? []).slice(0, 6).map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink-800">{entry.memo || `Entry #${entry.entry_no}`}</p>
                  <p className="text-xs text-ink-500">
                    {formatDate(entry.date)} · <span className="capitalize">{entry.source_type.replace(/_/g, ' ')}</span>
                  </p>
                </div>
              </li>
            ))}
            {!loading && !(data?.recentEntries ?? []).length && (
              <li className="px-5 py-8 text-center text-sm text-ink-500">No activity yet.</li>
            )}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: 'Reconcile the bank', body: 'Match statement lines and close the difference to zero.', to: '/banking', cta: 'Open banking' },
          { title: 'Close the month', body: 'Review the P&L, post adjustments and lock the period.', to: '/settings?tab=periods', cta: 'Periods & close' },
          { title: 'Chase a payment', body: 'Send a reminder with a secure payment link.', to: '/invoices?status=overdue', cta: 'Overdue invoices' },
          { title: 'Ask your accountant', body: 'Invite an accountant with full journal access.', to: '/settings?tab=users', cta: 'Manage users' },
        ].map((card) => (
          <Card key={card.title} className="flex flex-col justify-between p-5">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">{card.title}</h3>
              <p className="mt-1 text-xs text-ink-500">{card.body}</p>
            </div>
            <Link to={card.to} className="mt-4 text-xs font-semibold text-brand-800 hover:underline">
              {card.cta} →
            </Link>
          </Card>
        ))}
      </div>
    </>
  );
}
