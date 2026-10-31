import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney, formatNumber, titleCase, today } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Select,
  StatCard,
  StatusBadge,
  Table,
  TableSkeleton,
  Tabs,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface Employee {
  id: string;
  employee_no: string;
  name: string;
  email: string | null;
  pay_type: string;
  pay_rate: number;
  pay_frequency: string;
  hire_date: string | null;
  status: string;
}

interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: string;
  gross: number;
  tax_total: number;
  net_total: number;
  currency?: string;
}

interface Timesheet {
  id: string;
  employee_id: string;
  employee_name?: string;
  work_date: string;
  hours: number;
  project: string | null;
  billable: number;
  rate: number | null;
  description: string | null;
  status: string;
}

export function PayrollPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [view, setView] = useState<'runs' | 'employees' | 'timesheets'>('runs');
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [timesheetOpen, setTimesheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: runs, loading: runsLoading, error: runsError, reload: reloadRuns } = useQuery<{ data: PayrollRun[] }>('/payroll/runs');
  const { data: employees, loading: employeesLoading, reload: reloadEmployees } = useQuery<{ data: Employee[] }>('/employees');
  const { data: timesheets, loading: timesheetsLoading, reload: reloadTimesheets } = useQuery<{ data: Timesheet[] }>('/timesheets');
  const { data: summary, reload: reloadSummary } = useQuery<{ headcount: number; annualPayroll: number; recentRuns: PayrollRun[] }>('/payroll/summary');

  const act = async (run: PayrollRun, action: 'approve' | 'pay') => {
    setBusy(true);
    try {
      await api.post(`/payroll/runs/${run.id}/${action}`, {});
      toast.success(`Payroll ${action === 'approve' ? 'approved' : 'paid'}`, action === 'pay' ? 'Journal entry posted.' : 'Ready to pay.');
      reloadRuns();
      reloadSummary();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const approveTimesheet = async (entry: Timesheet) => {
    setBusy(true);
    try {
      await api.post('/timesheets/approve', { ids: [entry.id] });
      toast.success('Timesheet approved');
      reloadTimesheets();
    } catch (err) {
      toast.error('Could not approve', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Payroll & timesheets"
        description="Run payroll, withhold tax and turn approved hours into pay."
        actions={
          can('payroll:manage') ? (
            <>
              <Button variant="secondary" onClick={() => setEmployeeOpen(true)}>
                + Employee
              </Button>
              <Button variant="primary" onClick={() => setRunOpen(true)}>
                Run payroll
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setTimesheetOpen(true)}>
              Log time
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Headcount" value={String(summary?.headcount ?? employees?.data.length ?? 0)} hint="Active employees" />
        <StatCard label="Annual payroll" value={<Money amount={summary?.annualPayroll ?? 0} currency={currency} />} hint="Gross, annualised" />
        <StatCard label="Runs this year" value={String(runs?.data.length ?? 0)} hint="Approved and paid" />
        <StatCard
          label="Pending hours"
          value={formatNumber((timesheets?.data ?? []).filter((entry) => entry.status === 'submitted').reduce((sum, entry) => sum + entry.hours, 0), 1)}
          hint="Awaiting approval"
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-ink-200 px-4 pt-3">
          <Tabs
            ariaLabel="Payroll views"
            value={view}
            onChange={(value) => setView(value as 'runs' | 'employees' | 'timesheets')}
            tabs={[
              { id: 'runs', label: 'Pay runs' },
              { id: 'employees', label: 'Employees' },
              { id: 'timesheets', label: 'Timesheets' },
            ]}
          />
        </div>

        {view === 'runs' && (
          runsLoading && !runs ? (
            <TableSkeleton rows={4} columns={5} />
          ) : runsError ? (
            <ErrorState message={runsError} onRetry={reloadRuns} />
          ) : !runs?.data.length ? (
            <EmptyState title="No payroll runs yet" description="Add employees, then run payroll for the period." />
          ) : (
            <Table caption="Payroll runs">
              <THead>
                <tr>
                  <TH>Period</TH>
                  <TH>Pay date</TH>
                  <TH>Status</TH>
                  <TH numeric>Gross</TH>
                  <TH numeric>Tax</TH>
                  <TH numeric>Net</TH>
                  <TH>Actions</TH>
                </tr>
              </THead>
              <tbody>
                {runs.data.map((run) => (
                  <TR key={run.id}>
                    <TD>
                      {formatDate(run.period_start, 'short')} – {formatDate(run.period_end, 'short')}
                    </TD>
                    <TD>{formatDate(run.pay_date, 'short')}</TD>
                    <TD>
                      <StatusBadge status={run.status} />
                    </TD>
                    <TD numeric>{formatMoney(run.gross, currency)}</TD>
                    <TD numeric>{formatMoney(run.tax_total, currency)}</TD>
                    <TD numeric>{formatMoney(run.net_total, currency)}</TD>
                    <TD>
                      {can('payroll:manage') && run.status === 'draft' && (
                        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(run, 'approve')}>
                          Approve
                        </Button>
                      )}
                      {can('payroll:manage') && run.status === 'approved' && (
                        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(run, 'pay')}>
                          Pay
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )
        )}

        {view === 'employees' && (
          employeesLoading && !employees ? (
            <TableSkeleton rows={4} columns={4} />
          ) : !employees?.data.length ? (
            <EmptyState title="No employees" description="Add salaried or hourly employees to run payroll." />
          ) : (
            <Table caption="Employees">
              <THead>
                <tr>
                  <TH>Employee #</TH>
                  <TH>Name</TH>
                  <TH>Pay type</TH>
                  <TH numeric>Rate</TH>
                  <TH>Frequency</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {employees.data.map((employee) => (
                  <TR key={employee.id}>
                    <TD className="font-mono text-xs">{employee.employee_no}</TD>
                    <TD>
                      <p className="font-medium text-ink-900">{employee.name}</p>
                      {employee.email && <p className="text-xs text-ink-500">{employee.email}</p>}
                    </TD>
                    <TD className="capitalize">{employee.pay_type}</TD>
                    <TD numeric>{formatMoney(employee.pay_rate, currency)}</TD>
                    <TD className="capitalize">{employee.pay_frequency}</TD>
                    <TD>
                      <StatusBadge status={employee.status} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )
        )}

        {view === 'timesheets' && (
          <>
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2">
              <p className="text-xs text-ink-500">Hours logged by employees and contractors.</p>
              <Button size="sm" variant="secondary" onClick={() => setTimesheetOpen(true)}>
                Log time
              </Button>
            </div>
            {timesheetsLoading && !timesheets ? (
              <TableSkeleton rows={4} columns={5} />
            ) : !timesheets?.data.length ? (
              <EmptyState title="No time logged" description="Log hours against projects to bill or pay them." />
            ) : (
              <Table caption="Timesheets">
                <THead>
                  <tr>
                    <TH>Date</TH>
                    <TH>Employee</TH>
                    <TH>Project</TH>
                    <TH numeric>Hours</TH>
                    <TH>Billable</TH>
                    <TH>Status</TH>
                    <TH>Actions</TH>
                  </tr>
                </THead>
                <tbody>
                  {timesheets.data.map((entry) => (
                    <TR key={entry.id}>
                      <TD>{formatDate(entry.work_date, 'short')}</TD>
                      <TD>{entry.employee_name ?? '—'}</TD>
                      <TD>{entry.project ?? '—'}</TD>
                      <TD numeric>{formatNumber(entry.hours, 2)}</TD>
                      <TD>{entry.billable ? 'Yes' : 'No'}</TD>
                      <TD>
                        <StatusBadge status={entry.status} />
                      </TD>
                      <TD>
                        {entry.status === 'submitted' && can('timesheets:approve') && (
                          <Button size="sm" variant="ghost" loading={busy} onClick={() => void approveTimesheet(entry)}>
                            Approve
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Card>

      <EmployeeModal
        open={employeeOpen}
        onClose={() => setEmployeeOpen(false)}
        onSaved={() => {
          setEmployeeOpen(false);
          reloadEmployees();
          reloadSummary();
        }}
      />
      <RunPayrollModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        onSaved={() => {
          setRunOpen(false);
          reloadRuns();
          reloadSummary();
        }}
      />
      <TimesheetModal
        open={timesheetOpen}
        employees={employees?.data ?? []}
        onClose={() => setTimesheetOpen(false)}
        onSaved={() => {
          setTimesheetOpen(false);
          reloadTimesheets();
        }}
      />
    </>
  );
}

function EmployeeModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { session } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [form, setForm] = useState({ name: '', email: '', payType: 'salary', payRate: '', payFrequency: 'monthly', hireDate: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/employees', {
        name: form.name,
        email: form.email || undefined,
        payType: form.payType,
        payRate: Math.round(Number.parseFloat(form.payRate || '0') * 100),
        payFrequency: form.payFrequency,
        hireDate: form.hireDate,
      });
      toast.success('Employee added');
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
      title="New employee"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Add employee
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required htmlFor="employee-name">
          <Input id="employee-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Email" htmlFor="employee-email">
          <Input id="employee-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </Field>
        <Field label="Pay type" htmlFor="employee-type">
          <Select id="employee-type" value={form.payType} onChange={(event) => setForm({ ...form, payType: event.target.value })}>
            <option value="salary">Salary</option>
            <option value="hourly">Hourly</option>
          </Select>
        </Field>
        <Field label={`Rate (${currency})`} required htmlFor="employee-rate" hint={form.payType === 'salary' ? 'Annual gross salary' : 'Hourly rate'}>
          <Input id="employee-rate" inputMode="decimal" className="text-right" value={form.payRate} onChange={(event) => setForm({ ...form, payRate: event.target.value })} />
        </Field>
        <Field label="Pay frequency" htmlFor="employee-frequency">
          <Select id="employee-frequency" value={form.payFrequency} onChange={(event) => setForm({ ...form, payFrequency: event.target.value })}>
            {['weekly', 'biweekly', 'semimonthly', 'monthly', 'annual'].map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hire date" htmlFor="employee-hire">
          <Input id="employee-hire" type="date" value={form.hireDate} onChange={(event) => setForm({ ...form, hireDate: event.target.value })} />
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

function RunPayrollModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [periodStart, setPeriodStart] = useState(`${today().slice(0, 7)}-01`);
  const [periodEnd, setPeriodEnd] = useState(today());
  const [payDate, setPayDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/payroll/runs', { periodStart, periodEnd, payDate });
      toast.success('Payroll run created', 'Review and approve it before paying.');
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
      title="Run payroll"
      description="Gross pay, withholding and employer taxes are calculated per employee."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create run
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Period start" htmlFor="payroll-start">
          <Input id="payroll-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
        </Field>
        <Field label="Period end" htmlFor="payroll-end">
          <Input id="payroll-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
        </Field>
        <Field label="Pay date" htmlFor="payroll-paydate">
          <Input id="payroll-paydate" type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
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

function TimesheetModal({
  open,
  employees,
  onClose,
  onSaved,
}: {
  open: boolean;
  employees: Employee[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [workDate, setWorkDate] = useState(today());
  const [hours, setHours] = useState('8');
  const [project, setProject] = useState('');
  const [billable, setBillable] = useState(true);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/timesheets', {
        employeeId: employeeId || undefined,
        entries: [{ workDate, hours: Number(hours), project: project || undefined, billable, description: description || undefined }],
      });
      toast.success('Time logged');
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
      title="Log time"
      description="Approved hours can be billed to customers or included in payroll."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Save entry
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Employee" htmlFor="timesheet-employee" hint="Leave blank to log time for yourself.">
          <Select id="timesheet-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">Me (no employee record)</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" htmlFor="timesheet-date">
          <Input id="timesheet-date" type="date" value={workDate} onChange={(event) => setWorkDate(event.target.value)} />
        </Field>
        <Field label="Hours" htmlFor="timesheet-hours">
          <Input id="timesheet-hours" inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} />
        </Field>
        <Field label="Project" htmlFor="timesheet-project">
          <Input id="timesheet-project" value={project} onChange={(event) => setProject(event.target.value)} placeholder="Client delivery" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor="timesheet-description">
            <Input id="timesheet-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
        <label className="sm:col-span-2 flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={billable} onChange={(event) => setBillable(event.target.checked)} className="h-4 w-4 rounded border-ink-300 text-brand-700" />
          Billable to a customer
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
