import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { useSession } from '../lib/session';
import { Button, Card, CardHeader, PageHeader, ProgressBar, StatusBadge, Toggle } from '../components/ui';

interface Step {
  key: string;
  step_key?: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  days?: string;
}

const STEPS: Step[] = [
  {
    key: 'company',
    title: 'Confirm your company details',
    description: 'Name, fiscal year and currency feed every invoice, report and tax calculation.',
    href: '/settings?tab=company',
    cta: 'Company settings',
    days: '2 minutes',
  },
  {
    key: 'accounts',
    title: 'Review your chart of accounts',
    description: 'Start from an industry template and rename accounts to match how you think about the business.',
    href: '/accounts',
    cta: 'Open chart of accounts',
    days: '5 minutes',
  },
  {
    key: 'bank',
    title: 'Connect or import a bank statement',
    description: 'Import a CSV from your bank, or link a live feed. Reconciliation starts here.',
    href: '/banking',
    cta: 'Set up banking',
  },
  {
    key: 'customers',
    title: 'Add a customer or vendor',
    description: 'Payment terms and credit limits are applied automatically to new documents.',
    href: '/customers',
    cta: 'Add a customer',
  },
  {
    key: 'invoice',
    title: 'Create your first invoice',
    description: 'Send it with a payment link. Posting writes the double-entry journal automatically.',
    href: '/invoices?new=1',
    cta: 'New invoice',
  },
  {
    key: 'expenses',
    title: 'Record a bill or expense',
    description: 'Snap a receipt, categorise it and schedule the payment.',
    href: '/bills?new=1',
    cta: 'Record a bill',
  },
  {
    key: 'reconcile',
    title: 'Reconcile the bank account',
    description: 'Match statement lines, clear them and complete the reconciliation to zero difference.',
    href: '/banking',
    cta: 'Reconcile',
  },
  {
    key: 'reports',
    title: 'Run your first report',
    description: 'Profit & loss, balance sheet and aging — export to CSV or schedule an email.',
    href: '/reports',
    cta: 'Open reports',
  },
];

const TRAINING = [
  { title: 'Invoice to cash', body: 'Create an invoice, email it, record a partial payment and watch the aging report update.', to: '/invoices?new=1' },
  { title: 'Bill to payment', body: 'Enter a vendor bill, schedule it, run the payment batch and reconcile the bank line.', to: '/bills?new=1' },
  { title: 'Month-end close', body: 'Post an adjusting entry, review the trial balance and lock the period.', to: '/journal?new=1' },
  { title: 'Bank reconciliation', body: 'Import a statement, auto-match, review suggestions and complete the reconciliation.', to: '/banking' },
];

export function OnboardingPage(): React.JSX.Element {
  const { session, isRole } = useSession();
  const { data, loading, reload } = useQuery<{ data: Array<{ step_key: string; completed_at: string | null }>; completed: number }>('/onboarding');
  const [busy, setBusy] = useState<string | null>(null);
  const [trainingMode, setTrainingMode] = useState(false);

  const completedKeys = new Set((data?.data ?? []).filter((row) => row.completed_at).map((row) => row.step_key));
  const completed = STEPS.filter((step) => completedKeys.has(step.key)).length;
  const allDone = completed === STEPS.length;

  const complete = async (step: Step) => {
    setBusy(step.key);
    try {
      await api.post(`/onboarding/${step.key}`, {});
      toast.success('Step completed', step.title);
      reload();
    } catch (err) {
      toast.error('Could not save progress', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    try {
      await api.post('/onboarding/reset', {});
      toast.success('Checklist reset');
      reload();
    } catch (err) {
      toast.error('Could not reset', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={allDone ? 'You’re set up' : 'Get set up'}
        description="A short checklist to get accurate books from day one. You can skip steps and come back."
        actions={
          <>
            {isRole('admin') && (
              <Button variant="ghost" loading={busy === 'reset'} onClick={() => void reset()}>
                Reset checklist
              </Button>
            )}
            <Link to="/" className="btn-secondary">
              Go to dashboard
            </Link>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Setup checklist" description={`${completed} of ${STEPS.length} complete`} />
          <div className="px-5 pt-4">
            <ProgressBar value={completed} max={STEPS.length} label="Progress" />
          </div>
          <ol className="divide-y divide-ink-100 px-5 pb-4">
            {STEPS.map((step, index) => {
              const done = completedKeys.has(step.key);
              return (
                <li key={step.key} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        done ? 'bg-brand-600 text-white' : 'border border-ink-300 text-ink-500'
                      }`}
                    >
                      {done ? '✓' : index + 1}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-ink-900">{step.title}</p>
                      <p className="mt-0.5 max-w-lg text-xs text-ink-500">{step.description}</p>
                      {step.days && <p className="mt-0.5 text-[11px] text-ink-400">About {step.days}</p>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pl-9 sm:pl-0">
                    <Link to={step.href} className="btn-secondary px-2.5 py-1.5 text-xs">
                      {step.cta}
                    </Link>
                    {!done && (
                      <Button size="sm" variant="ghost" loading={busy === step.key} onClick={() => void complete(step)}>
                        Mark done
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Training mode" description="Practise on the sandbox company without touching real books." />
            <div className="px-5 py-3">
              <Toggle
                label="Show guided walkthroughs"
                description="Adds hints on key screens and links to practice scenarios."
                checked={trainingMode}
                onChange={(next) => {
                  setTrainingMode(next);
                  localStorage.setItem('ledgerline.trainingMode', next ? '1' : '0');
                  toast.info(next ? 'Training mode on' : 'Training mode off');
                }}
              />
              {session?.tenant.isSandbox ? (
                <p className="mt-1 flex items-center gap-2 text-xs text-ink-500">
                  <StatusBadge status="active" label="Sandbox workspace" />
                  This company contains sample data you can change freely.
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-500">
                  Tip: sign out and use <strong>Explore the demo company</strong> on the login screen for a safe sandbox.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="What happens next" />
            <ul className="space-y-2 p-5 text-xs text-ink-600">
              <li>Invoices and bills post to the ledger automatically once sent or saved as open.</li>
              <li>Bank lines are matched against payments; unmatched lines can be categorised or excluded.</li>
              <li>Every change is recorded in the audit trail with before/after values.</li>
              <li>Reports always read from the posted ledger — never from editable totals.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader title="Guided walkthroughs" description="Short, realistic scenarios to build confidence." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {TRAINING.map((walkthrough) => (
            <div key={walkthrough.title} className="rounded-lg border border-ink-200 p-4">
              <h3 className="text-sm font-semibold text-ink-900">{walkthrough.title}</h3>
              <p className="mt-1 text-xs text-ink-500">{walkthrough.body}</p>
              <Link to={walkthrough.to} className="mt-3 inline-block text-xs font-semibold text-brand-800 hover:underline">
                Start walkthrough →
              </Link>
            </div>
          ))}
        </div>
      </Card>

      {loading && <p className="mt-3 text-xs text-ink-500">Loading progress…</p>}
    </>
  );
}
