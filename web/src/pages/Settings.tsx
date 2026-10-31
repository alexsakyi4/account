import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatDateTime, formatMoney, titleCase, today, toMinor } from '../lib/format';
import { useSession, type Role } from '../lib/session';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  HelpTip,
  Input,
  Modal,
  Money,
  PageHeader,
  ProgressBar,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  Tabs,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  Toggle,
} from '../components/ui';

const TABS = [
  { id: 'company', label: 'Company' },
  { id: 'users', label: 'Users & roles' },
  { id: 'taxes', label: 'Taxes' },
  { id: 'currencies', label: 'Currencies' },
  { id: 'features', label: 'Features' },
  { id: 'periods', label: 'Periods & close' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'audit', label: 'Audit' },
  { id: 'security', label: 'Security' },
  { id: 'billing', label: 'Billing' },
  { id: 'privacy', label: 'Data & privacy' },
  { id: 'profile', label: 'Profile' },
];

export function SettingsPage(): React.JSX.Element {
  const { can, session } = useSession();
  const [params, setParams] = useSearchParams();
  const active = params.get('tab') ?? 'company';

  return (
    <>
      <PageHeader
        title="Settings"
        description={`${session?.tenant.name} · ${session?.role} access`}
        actions={
          <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="btn-secondary">
            API documentation
          </a>
        }
      />
      <div className="mb-6 overflow-x-auto border-b border-ink-200">
        <Tabs
          ariaLabel="Settings sections"
          value={active}
          onChange={(tab) => {
            const next = new URLSearchParams(params);
            next.set('tab', tab);
            setParams(next, { replace: true });
          }}
          tabs={TABS.map((tab) => ({
            ...tab,
            disabled:
              (tab.id === 'billing' && !can('billing:manage')) ||
              (tab.id === 'users' && !can('users:manage')) ||
              (tab.id === 'audit' && !can('audit:read')),
          }))}
        />
      </div>

      {active === 'company' && <CompanyTab />}
      {active === 'users' && <UsersTab />}
      {active === 'taxes' && <TaxesTab />}
      {active === 'currencies' && <CurrenciesTab />}
      {active === 'features' && <FeaturesTab />}
      {active === 'periods' && <PeriodsTab />}
      {active === 'integrations' && <IntegrationsTab />}
      {active === 'audit' && <AuditTab />}
      {active === 'security' && <SecurityTab />}
      {active === 'billing' && <BillingTab />}
      {active === 'privacy' && <PrivacyTab />}
      {active === 'profile' && <ProfileTab />}
    </>
  );
}

/* --------------------------------------------------------------- company */

interface CompanyResponse {
  company: {
    id: string;
    name: string;
    legal_name: string | null;
    industry: string | null;
    base_currency: string;
    fiscal_year_start_month: number;
    plan: string;
    email: string | null;
    phone: string | null;
    website: string | null;
    is_sandbox: number;
    settings: Record<string, unknown>;
  };
}

function CompanyTab(): React.JSX.Element {
  const { refresh } = useSession();
  const { data, loading, reload: reloadCompany } = useQuery<CompanyResponse>('/company');
  const [form, setForm] = useState({
    name: '',
    legalName: '',
    email: '',
    phone: '',
    website: '',
    industry: '',
    baseCurrency: 'USD',
    fiscalYearStartMonth: '1',
    invoicePrefix: 'INV',
    invoiceFooter: '',
    defaultPaymentTermsDays: '30',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);

  useEffect(() => {
    if (data && !initialised) {
      const settings = (data.company.settings ?? {}) as Record<string, unknown>;
      setForm({
        name: data.company.name,
        legalName: data.company.legal_name ?? '',
        email: data.company.email ?? '',
        phone: data.company.phone ?? '',
        website: data.company.website ?? '',
        industry: data.company.industry ?? '',
        baseCurrency: data.company.base_currency,
        fiscalYearStartMonth: String(data.company.fiscal_year_start_month ?? 1),
        invoicePrefix: String(settings.invoicePrefix ?? 'INV'),
        invoiceFooter: String(settings.invoiceFooter ?? ''),
        defaultPaymentTermsDays: String(settings.defaultPaymentTermsDays ?? 30),
      });
      setInitialised(true);
    }
  }, [data, initialised]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/company', {
        name: form.name,
        legalName: form.legalName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        website: form.website || undefined,
        industry: form.industry || undefined,
        baseCurrency: form.baseCurrency,
        fiscalYearStartMonth: Number(form.fiscalYearStartMonth),
        settings: {
          invoicePrefix: form.invoicePrefix,
          invoiceFooter: form.invoiceFooter,
          defaultPaymentTermsDays: Number(form.defaultPaymentTermsDays),
        },
      });
      toast.success('Company settings saved');
      reloadCompany();
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <TableSkeleton rows={5} columns={2} />;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Company profile" description="Appears on invoices, statements and reports." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Trading name" required htmlFor="company-name">
            <Input id="company-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Legal name" htmlFor="company-legal">
            <Input id="company-legal" value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} />
          </Field>
          <Field label="Email" htmlFor="company-email">
            <Input id="company-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Phone" htmlFor="company-phone">
            <Input id="company-phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </Field>
          <Field label="Website" htmlFor="company-website">
            <Input id="company-website" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
          </Field>
          <Field label="Industry" htmlFor="company-industry">
            <Input id="company-industry" value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} />
          </Field>
          <Field label="Base currency" htmlFor="company-currency" hint="Changing this does not restate historic entries.">
            <Select id="company-currency" value={form.baseCurrency} onChange={(event) => setForm({ ...form, baseCurrency: event.target.value })}>
              {['USD', 'EUR', 'GBP', 'GHS', 'NGN', 'KES', 'CAD', 'AUD', 'ZAR', 'INR'].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fiscal year starts" htmlFor="company-fiscal">
            <Select id="company-fiscal" value={form.fiscalYearStartMonth} onChange={(event) => setForm({ ...form, fiscalYearStartMonth: event.target.value })}>
              {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                <option key={month} value={month}>
                  {new Date(Date.UTC(2024, month - 1, 1)).toLocaleString('en-US', { month: 'long' })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Invoicing defaults" description="Applied to new documents." />
        <div className="space-y-4 p-5">
          <Field label="Invoice prefix" htmlFor="invoice-prefix">
            <Input id="invoice-prefix" value={form.invoicePrefix} onChange={(event) => setForm({ ...form, invoicePrefix: event.target.value.toUpperCase() })} maxLength={10} />
          </Field>
          <Field label="Default terms (days)" htmlFor="invoice-terms">
            <Input id="invoice-terms" inputMode="numeric" value={form.defaultPaymentTermsDays} onChange={(event) => setForm({ ...form, defaultPaymentTermsDays: event.target.value })} />
          </Field>
          <Field label="Invoice footer" htmlFor="invoice-footer">
            <Textarea id="invoice-footer" value={form.invoiceFooter} onChange={(event) => setForm({ ...form, invoiceFooter: event.target.value })} />
          </Field>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" className="w-full" loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader title="Compliance & environment" />
        <dl className="grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Plan</dt>
            <dd className="text-sm font-medium capitalize text-ink-900">{data?.company.plan}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Data region</dt>
            <dd className="text-sm font-medium text-ink-900">Managed Postgres / SQLite (self-host)</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Sandbox</dt>
            <dd className="text-sm font-medium text-ink-900">{data?.company.is_sandbox ? 'Yes — sample data' : 'No'}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- users */

interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
}

function UsersTab(): React.JSX.Element {
  const { data, loading, reload } = useQuery<{ data: Member[]; roles: Role[]; permissionMatrix: Record<string, string[]> }>('/users');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('bookkeeper');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  const invite = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ inviteUrl?: string }>('/users/invite', { email, role, name: name || undefined });
      toast.success('Invitation sent', result.inviteUrl ? 'Copy the link from your email console if SMTP is not configured.' : undefined);
      setInviteOpen(false);
      setEmail('');
      setName('');
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, nextRole: Role) => {
    try {
      await api.patch(`/users/${member.id}`, { role: nextRole });
      toast.success('Role updated', `${member.name} is now a ${nextRole}.`);
      reload();
    } catch (err) {
      toast.error('Could not change role', errorMessage(err));
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await api.delete(`/users/${removeTarget.id}`);
      toast.success('Member removed');
      setRemoveTarget(null);
      reload();
    } catch (err) {
      toast.error('Could not remove member', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-2">
        <CardHeader
          title="Team"
          description="Roles control what each person can see and do."
          action={
            <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
              Invite member
            </Button>
          }
        />
        {loading && !data ? (
          <TableSkeleton rows={3} columns={4} />
        ) : (
          <Table caption="Team members">
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>2FA</TH>
                <TH>Last sign-in</TH>
                <TH>Actions</TH>
              </tr>
            </THead>
            <tbody>
              {(data?.data ?? []).map((member) => (
                <TR key={member.id}>
                  <TD>
                    <p className="font-medium text-ink-900">{member.name}</p>
                    <p className="text-xs text-ink-500">{member.email}</p>
                  </TD>
                  <TD>
                    <Select
                      value={member.role}
                      aria-label={`Role for ${member.name}`}
                      className="w-36 py-1 text-xs"
                      onChange={(event) => void changeRole(member, event.target.value as Role)}
                    >
                      {['admin', 'accountant', 'bookkeeper', 'employee'].map((option) => (
                        <option key={option} value={option}>
                          {titleCase(option)}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    {member.twoFactorEnabled ? <StatusBadge status="active" label="On" /> : <StatusBadge status="pending" label="Off" />}
                  </TD>
                  <TD className="text-xs">{member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}</TD>
                  <TD>
                    <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setRemoveTarget(member)}>
                      Remove
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="What each role can do" />
        <div className="space-y-3 p-5">
          {(data?.roles ?? []).map((roleName) => (
            <div key={roleName}>
              <p className="text-sm font-semibold capitalize text-ink-900">{roleName}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {(data?.permissionMatrix?.[roleName] ?? []).map((permission) => permission.replace(':', ' ')).join(' · ')}
              </p>
            </div>
          ))}
          <p className="flex items-center gap-1 border-t border-ink-100 pt-3 text-xs text-ink-500">
            <HelpTip text="Employees only see their own expenses and timesheets. Admins can require 2FA for every admin in Security.">
              Role model
            </HelpTip>
          </p>
        </div>
      </Card>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a team member"
        description="They receive a single-use link that expires in 7 days."
        footer={
          <>
            <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void invite()}>
              Send invitation
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Email" required htmlFor="invite-email">
            <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Name" htmlFor="invite-name-person">
            <Input id="invite-name-person" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Role" htmlFor="invite-role" hint="Admins manage billing, users and settings. Accountants handle journals and reports.">
            <Select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {['admin', 'accountant', 'bookkeeper', 'employee'].map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
          </Field>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name ?? 'member'}?`}
        description="They lose access immediately. Their audit history and journal entries remain."
        confirmLabel="Remove member"
        destructive
        loading={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoveTarget(null)}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- taxes */

function TaxesTab(): React.JSX.Element {
  const { data, loading, reload } = useQuery<{ data: Array<{ id: string; code: string; name: string; rate_bp: number; tax_type: string; is_inclusive: number; is_active: number; account_id: string | null }> }>('/tax-codes');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', rate: '15', taxType: 'vat', isInclusive: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/tax-codes', {
        code: form.code,
        name: form.name,
        rateBp: Math.round(Number.parseFloat(form.rate || '0') * 100),
        taxType: form.taxType,
        isInclusive: form.isInclusive,
      });
      toast.success('Tax code created');
      setOpen(false);
      setForm({ code: '', name: '', rate: '15', taxType: 'vat', isInclusive: false });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Tax codes"
          description="Used on invoices, bills and expenses. Rates are stored in basis points."
          action={
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              + New tax code
            </Button>
          }
        />
        {loading && !data ? (
          <TableSkeleton rows={4} columns={4} />
        ) : (
          <Table caption="Tax codes">
            <THead>
              <tr>
                <TH>Code</TH>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH numeric>Rate</TH>
                <TH>Inclusive</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <tbody>
              {(data?.data ?? []).map((code) => (
                <TR key={code.id}>
                  <TD className="font-mono text-xs">{code.code}</TD>
                  <TD>{code.name}</TD>
                  <TD className="uppercase text-xs">{code.tax_type}</TD>
                  <TD numeric>{(code.rate_bp / 100).toFixed(2)}%</TD>
                  <TD>{code.is_inclusive ? 'Yes' : 'No'}</TD>
                  <TD>
                    <StatusBadge status={code.is_active ? 'active' : 'void'} label={code.is_active ? 'Active' : 'Inactive'} />
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
        title="New tax code"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              Create tax code
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required htmlFor="tax-code">
            <Input id="tax-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} placeholder="VAT15" />
          </Field>
          <Field label="Name" required htmlFor="tax-name">
            <Input id="tax-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="VAT 15%" />
          </Field>
          <Field label="Rate (%)" required htmlFor="tax-rate">
            <Input id="tax-rate" inputMode="decimal" value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} />
          </Field>
          <Field label="Type" htmlFor="tax-type">
            <Select id="tax-type" value={form.taxType} onChange={(event) => setForm({ ...form, taxType: event.target.value })}>
              {['vat', 'gst', 'sales', 'custom'].map((option) => (
                <option key={option} value={option}>
                  {option.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={form.isInclusive} onChange={(event) => setForm({ ...form, isInclusive: event.target.checked })} className="h-4 w-4 rounded border-ink-300 text-brand-700" />
            Prices already include this tax
          </label>
          {error && (
            <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ currencies */

function CurrenciesTab(): React.JSX.Element {
  const { session } = useSession();
  const base = session?.tenant.currency ?? 'USD';
  const { data, loading, reload } = useQuery<{ data: Array<{ id: string; code: string; name: string; symbol: string; is_base: number; rate: number; rateDate: string }> }>('/currencies');
  const [form, setForm] = useState({ quoteCurrency: 'EUR', rate: '', rateDate: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [convert, setConvert] = useState({ amount: '100', from: base, to: 'EUR' });
  const [converted, setConverted] = useState<string | null>(null);

  const saveRate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/currencies/rates', { quoteCurrency: form.quoteCurrency, rate: Number(form.rate), rateDate: form.rateDate });
      toast.success('Exchange rate saved');
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runConversion = async () => {
    try {
      const result = await api.get<{ amount: number; rate: number; result: number }>('/currencies/convert', {
        amount: convert.amount,
        from: convert.from,
        to: convert.to,
      });
      setConverted(`${formatMoney(result.result ?? 0, convert.to)} at ${result.rate}`);
    } catch (err) {
      toast.error('Conversion failed', errorMessage(err));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-2">
        <CardHeader title="Exchange rates" description={`Base currency: ${base}. Rates are units of quote currency per 1 ${base}.`} />
        {loading && !data ? (
          <TableSkeleton rows={4} columns={4} />
        ) : (
          <Table caption="Currencies">
            <THead>
              <tr>
                <TH>Currency</TH>
                <TH>Name</TH>
                <TH numeric>Rate</TH>
                <TH>As of</TH>
              </tr>
            </THead>
            <tbody>
              {(data?.data ?? []).map((currency) => (
                <TR key={currency.id}>
                  <TD className="font-mono text-xs">{currency.code}</TD>
                  <TD>
                    {currency.name}
                    {currency.is_base ? <span className="ml-2 badge bg-brand-100 text-brand-800">Base</span> : null}
                  </TD>
                  <TD numeric>{currency.is_base ? '1.0000' : Number(currency.rate).toFixed(4)}</TD>
                  <TD>{currency.rateDate ? formatDate(currency.rateDate, 'short') : '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader title="Add a rate" />
          <div className="space-y-3 p-5">
            <Field label="Quote currency" htmlFor="rate-currency">
              <Input id="rate-currency" value={form.quoteCurrency} maxLength={3} onChange={(event) => setForm({ ...form, quoteCurrency: event.target.value.toUpperCase() })} />
            </Field>
            <Field label="Rate" htmlFor="rate-value" hint={`1 ${base} equals this many ${form.quoteCurrency}.`}>
              <Input id="rate-value" inputMode="decimal" value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} placeholder="0.92" />
            </Field>
            <Field label="Rate date" htmlFor="rate-date">
              <Input id="rate-date" type="date" value={form.rateDate} onChange={(event) => setForm({ ...form, rateDate: event.target.value })} />
            </Field>
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
            <Button variant="primary" className="w-full" loading={busy} onClick={() => void saveRate()}>
              Save rate
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Convert" />
          <div className="space-y-3 p-5">
            <div className="grid grid-cols-2 gap-2">
              <Field label="From" htmlFor="convert-from">
                <Input id="convert-from" value={convert.from} maxLength={3} onChange={(event) => setConvert({ ...convert, from: event.target.value.toUpperCase() })} />
              </Field>
              <Field label="To" htmlFor="convert-to">
                <Input id="convert-to" value={convert.to} maxLength={3} onChange={(event) => setConvert({ ...convert, to: event.target.value.toUpperCase() })} />
              </Field>
            </div>
            <Field label="Amount" htmlFor="convert-amount">
              <Input id="convert-amount" inputMode="decimal" value={convert.amount} onChange={(event) => setConvert({ ...convert, amount: event.target.value })} />
            </Field>
            <Button className="w-full" onClick={() => void runConversion()}>
              Convert
            </Button>
            {converted && <p className="text-sm font-medium text-ink-900">{converted}</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- features */

function FeaturesTab(): React.JSX.Element {
  const { refresh } = useSession();
  const { data, loading, reload: reloadFlags } = useQuery<{
    flags: Array<{ key: string; label: string; description: string; enabled: boolean; default: boolean }>;
  }>('/flags');
  const [busy, setBusy] = useState<string | null>(null);

  const update = async (key: string, enabled: boolean) => {
    setBusy(key);
    try {
      await api.patch(`/flags/${key}`, { enabled });
      toast.success(`${titleCase(key)} ${enabled ? 'enabled' : 'disabled'}`);
      reloadFlags();
      void refresh();
    } catch (err) {
      toast.error('Could not update flag', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <TableSkeleton rows={5} columns={2} />;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Modules" description="Turn optional modules on or off. Turning payroll off hides it for everyone." />
        <div className="divide-y divide-ink-100 px-5">
          {(data?.flags ?? []).map((flag) => (
            <Toggle
              key={flag.key}
              label={flag.label}
              description={flag.description}
              checked={flag.enabled}
              disabled={busy === flag.key}
              onChange={(next) => void update(flag.key, next)}
            />
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">About feature flags</h2>
        <ul className="mt-2 space-y-2 text-xs text-ink-600">
          <li>Flags are per-tenant and audited.</li>
          <li>Disabling payroll keeps historical pay runs but hides the module.</li>
          <li>Inventory controls stock tracking, COGS postings and item pickers.</li>
          <li>Multi-currency enables foreign-currency invoices and FX revaluation.</li>
          <li>Plan limits still apply regardless of flags.</li>
        </ul>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- periods */

function PeriodsTab(): React.JSX.Element {
  const { data, loading, reload } = useQuery<{ data: Array<{ id: string; name: string; start_date: string; end_date: string; status: string; entry_count: number }> }>('/periods');
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; name: string; status: string } | null>(null);

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ created: number }>('/periods/generate', { year: Number(year) });
      toast.success('Periods generated', `${result.created ?? 0} months added.`);
      reload();
    } catch (err) {
      toast.error('Could not generate periods', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: 'open' | 'closed' | 'locked') => {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.post(`/periods/${confirm.id}/publish`, { status });
      toast.success(status === 'open' ? 'Period reopened' : `Period ${status}`);
      setConfirm(null);
      reload();
    } catch (err) {
      toast.error('Could not update period', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Fiscal periods"
          description="Closing a period blocks new postings dated inside it."
          action={
            <div className="flex items-end gap-2">
              <Input value={year} onChange={(event) => setYear(event.target.value)} aria-label="Year to generate" className="w-20 py-1.5 text-xs" />
              <Button size="sm" loading={busy} onClick={() => void generate()}>
                Generate year
              </Button>
            </div>
          }
        />
        {loading && !data ? (
          <TableSkeleton rows={6} columns={3} />
        ) : (
          <Table caption="Fiscal periods">
            <THead>
              <tr>
                <TH>Period</TH>
                <TH>Dates</TH>
                <TH numeric>Entries</TH>
                <TH>Status</TH>
                <TH>Actions</TH>
              </tr>
            </THead>
            <tbody>
              {(data?.data ?? []).map((period) => (
                <TR key={period.id}>
                  <TD>{period.name}</TD>
                  <TD className="text-xs">
                    {formatDate(period.start_date, 'short')} – {formatDate(period.end_date, 'short')}
                  </TD>
                  <TD numeric>{period.entry_count}</TD>
                  <TD>
                    <StatusBadge
                      status={period.status === 'open' ? 'active' : period.status === 'locked' ? 'excluded' : 'void'}
                      label={titleCase(period.status)}
                    />
                  </TD>
                  <TD>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(period)}>
                      Change status
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={`Change status for ${confirm?.name ?? ''}`}
        description="Locked periods cannot be reopened from the UI; contact support for a controlled unlock."
        size="sm"
        footer={
          <>
            <Button variant="secondary" loading={busy} onClick={() => void setStatus('open')}>
              Reopen
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void setStatus('closed')}>
              Close period
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void setStatus('locked')}>
              Lock
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-600">
          Closing is reversible. Locking is intended for audited periods after your accountant signs off.
        </p>
      </Modal>
    </>
  );
}

/* ----------------------------------------------------------- integrations */

function IntegrationsTab(): React.JSX.Element {
  const { data: integrations } = useQuery<{
    payments: { provider: string; configured: boolean };
    bankFeeds: { provider: string; configured: boolean };
    ocr: { provider: string; configured: boolean };
    email: { transport: string };
    api: { baseUrl: string; version: string };
  }>('/integrations');
  const { data: keys, reload: reloadKeys } = useQuery<{ data: Array<{ id: string; name: string; prefix: string; scopes: string; last_used_at: string | null; created_at: string; revoked_at: string | null }> }>('/api-keys');
  const { data: hooks, reload: reloadHooks } = useQuery<{ data: Array<{ id: string; url: string; events: string; is_active: number; pending: number; failed: number; created_at: string }> }>('/webhooks');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [hookOpen, setHookOpen] = useState(false);
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState('invoice.created,invoice.paid,payment.received');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ token: string }>('/api-keys', { name: keyName || 'Default key' });
      setCreatedKey(result.token);
      reloadKeys();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createHook = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ secret: string }>('/webhooks', {
        url: hookUrl,
        events: hookEvents.split(',').map((event) => event.trim()).filter(Boolean),
      });
      setCreatedSecret(result.secret);
      reloadHooks();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Card payments', value: integrations?.payments.configured ? 'Stripe' : 'Sandbox', hint: 'Tokenised — PCI SAQ A scope' },
          { label: 'Bank feeds', value: integrations?.bankFeeds.configured ? 'Plaid' : 'CSV import', hint: 'Statement import always available' },
          { label: 'Receipt OCR', value: integrations?.ocr.provider ?? 'local', hint: 'Images never leave your region when local' },
          { label: 'Email', value: integrations?.email.transport ?? 'capture', hint: 'Add SMTP_URL for real delivery' },
        ].map((card) => (
          <Card key={card.label} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">{card.label}</p>
            <p className="mt-1 text-sm font-semibold capitalize text-ink-900">{card.value}</p>
            <p className="mt-0.5 text-xs text-ink-500">{card.hint}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="API keys"
          description="Machine-to-machine access with the same tenant isolation as a user session."
          action={
            <Button size="sm" variant="primary" onClick={() => { resetKeyDialog(); setKeyOpen(true); }}>
              + New key
            </Button>
          }
        />
        <Table caption="API keys">
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Prefix</TH>
              <TH>Scopes</TH>
              <TH>Last used</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <tbody>
            {(keys?.data ?? []).map((key) => (
              <TR key={key.id}>
                <TD>{key.name}</TD>
                <TD className="font-mono text-xs">{key.prefix}…</TD>
                <TD className="text-xs">{key.scopes}</TD>
                <TD className="text-xs">{key.last_used_at ? formatDateTime(key.last_used_at) : 'Never'}</TD>
                <TD>
                  {key.revoked_at ? (
                    <span className="text-xs text-ink-500">Revoked</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-700"
                      onClick={async () => {
                        try {
                          await api.delete(`/api-keys/${key.id}`);
                          toast.success('Key revoked');
                          reloadKeys();
                        } catch (err) {
                          toast.error('Could not revoke key', errorMessage(err));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
            {!(keys?.data ?? []).length && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-500">
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Webhooks"
          description="Signed with HMAC-SHA256 (x-ledgerline-signature). Retries with exponential backoff."
          action={
            <Button size="sm" variant="primary" onClick={() => { setCreatedSecret(null); setHookOpen(true); }}>
              + New webhook
            </Button>
          }
        />
        <Table caption="Webhooks">
          <THead>
            <tr>
              <TH>Endpoint</TH>
              <TH>Events</TH>
              <TH numeric>Pending</TH>
              <TH numeric>Failed</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <tbody>
            {(hooks?.data ?? []).map((hook) => (
              <TR key={hook.id}>
                <TD className="max-w-64 truncate font-mono text-xs">{hook.url}</TD>
                <TD className="text-xs">{hook.events}</TD>
                <TD numeric>{hook.pending}</TD>
                <TD numeric>{hook.failed}</TD>
                <TD>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api.post('/webhooks/test', {});
                        toast.success('Test event queued', 'The worker delivers it within 15 seconds.');
                      } catch (err) {
                        toast.error('Could not send test', errorMessage(err));
                      }
                    }}
                  >
                    Send test
                  </Button>
                </TD>
              </TR>
            ))}
            {!(hooks?.data ?? []).length && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-500">
                  No webhooks registered.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Base URL</h2>
        <p className="mt-1 font-mono text-xs text-ink-600">{integrations?.api.baseUrl}</p>
        <p className="mt-2 text-xs text-ink-500">
          Authenticate with <code className="rounded bg-ink-100 px-1">Authorization: Bearer &lt;jwt&gt;</code> or{' '}
          <code className="rounded bg-ink-100 px-1">X-API-Key</code>. See the{' '}
          <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="font-semibold text-brand-800 underline">
            API explorer
          </a>
          .
        </p>
      </Card>

      <Modal
        open={keyOpen}
        onClose={() => { setKeyOpen(false); setCreatedKey(null); setKeyName(''); }}
        title="Create an API key"
        description="The token is shown once — store it in your secret manager."
        footer={
          createdKey ? (
            <Button variant="primary" onClick={() => { setKeyOpen(false); setCreatedKey(null); setKeyName(''); }}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setKeyOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={() => void createKey()}>
                Create key
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-600">Copy this key now. It cannot be retrieved again.</p>
            <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-xs text-brand-200">{createdKey}</pre>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(createdKey);
                toast.success('Key copied');
              }}
            >
              Copy to clipboard
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Key name" htmlFor="api-key-name">
              <Input id="api-key-name" value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="Reporting integration" />
            </Field>
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={hookOpen}
        onClose={() => { setHookOpen(false); setCreatedSecret(null); }}
        title="Register a webhook"
        description="HTTPS endpoints only in production. Deliveries are retried up to six times."
        footer={
          createdSecret ? (
            <Button variant="primary" onClick={() => { setHookOpen(false); setCreatedSecret(null); setHookUrl(''); }}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setHookOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={() => void createHook()}>
                Register webhook
              </Button>
            </>
          )
        }
      >
        {createdSecret ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-600">Signing secret (verify with HMAC-SHA256 over `timestamp.body`):</p>
            <pre className="overflow-x-auto rounded-lg bg-ink-900 p-3 text-xs text-brand-200">{createdSecret}</pre>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Endpoint URL" required htmlFor="webhook-url">
              <Input id="webhook-url" value={hookUrl} onChange={(event) => setHookUrl(event.target.value)} placeholder="https://example.com/webhooks/ledgerline" />
            </Field>
            <Field label="Events" htmlFor="webhook-events" hint="Comma separated. Use * for all events.">
              <Input id="webhook-events" value={hookEvents} onChange={(event) => setHookEvents(event.target.value)} />
            </Field>
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );

  function resetKeyDialog(): void {
    setCreatedKey(null);
    setKeyName('');
    setError(null);
  }
}

/* ----------------------------------------------------------------- audit */

interface AuditRow {
  id: string;
  seq: number;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
  actor_email: string | null;
  created_at: string;
  hash?: string;
}

function AuditTab(): React.JSX.Element {
  const { data, loading, reload } = useQuery<{ data: AuditRow[] }>('/activity', { pageSize: 50 });
  const [verification, setVerification] = useState<{ valid: boolean; entries: number; brokenAt?: number } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await api.get<{ valid: boolean; entries: number; brokenAt?: number }>('/audit/verify');
      setVerification(result);
      if (result.valid) toast.success('Audit chain intact', `${result.entries} entries verified.`);
      else toast.error('Audit chain broken', `First inconsistency at entry ${result.brokenAt}.`);
    } catch (err) {
      toast.error('Verification failed', errorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  const exportCsv = async () => {
    try {
      const result = await api.get<{ filename: string; content: string }>('/audit/export');
      const blob = new Blob([result.content], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Immutable audit trail</h2>
            <p className="mt-1 max-w-xl text-xs text-ink-500">
              Each entry is hash-chained to the previous one, so edits or deletions are detectable. Verification walks the
              entire chain for this tenant.
            </p>
            {verification && (
              <p className={`mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${ verification.valid ? 'bg-brand-50 text-brand-900' : 'bg-red-50 text-red-800' }`} role="status">
                {verification.valid
                  ? `Chain intact across ${verification.entries} entries.`
                  : `Chain broken at entry ${verification.brokenAt}.`}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" loading={verifying} onClick={() => void verify()}>
              Verify chain
            </Button>
            <Button variant="secondary" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Recent activity" description="Every write in this tenant is recorded with the actor and before/after values." />
        {loading && !data ? (
          <TableSkeleton rows={8} columns={4} />
        ) : (
          <Table caption="Audit log">
            <THead>
              <tr>
                <TH>Seq</TH>
                <TH>When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Summary</TH>
              </tr>
            </THead>
            <tbody>
              {(data?.data ?? []).map((row) => (
                <TR key={row.id}>
                  <TD className="tabular-nums text-xs">{row.seq}</TD>
                  <TD className="text-xs">{formatDateTime(row.created_at)}</TD>
                  <TD className="text-xs">{row.actor_email ?? 'system'}</TD>
                  <TD>
                    <span className="badge bg-ink-100 font-mono text-[11px] text-ink-700">{row.action}</span>
                  </TD>
                  <TD className="max-w-80 truncate text-xs">{row.summary ?? `${row.entity_type} ${row.entity_id.slice(0, 8)}`}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={reload}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- security */

function SecurityTab(): React.JSX.Element {
  const { session, refresh } = useSession();
  const { data, reload: reloadOverview } = useQuery<{
    twoFactor: { required: boolean; admins: number; adminsWith2fa: number; enabledForCurrentUser: boolean };
    members: number;
    recentLogins: Array<{ email: string; success: number; ip: string; created_at: string }>;
    encryptionAtRest: string;
    sessionPolicy: { accessTokenMinutes: number; refreshDays: number };
  }>('/security/overview');
  const { data: sessions, reload: reloadSessions } = useQuery<{ data: Array<{ id: string; user_agent: string; ip: string; created_at: string; expires_at: string; revoked_at: string | null }> }>('/auth/sessions');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const startSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', {});
      setSetup(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
      setRecovery(result.recoveryCodes ?? []);
      setSetup(null);
      setCode('');
      toast.success('Two-factor enabled', 'Store your recovery codes somewhere safe.');
      reloadOverview();
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Two-factor authentication" description="Required for admins handling money and settings." />
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ink-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink-900">
                {session?.twoFactorEnabled ? 'Two-factor is on for your account' : 'Two-factor is off for your account'}
              </p>
              <p className="text-xs text-ink-500">
                {data?.twoFactor.adminsWith2fa ?? 0} of {data?.twoFactor.admins ?? 0} admins protected
              </p>
            </div>
            {!session?.twoFactorEnabled && (
              <Button variant="primary" loading={busy} onClick={() => void startSetup()}>
                Set up 2FA
              </Button>
            )}
          </div>

          {setup && (
            <div className="rounded-lg border border-ink-200 p-4">
              <p className="text-sm font-medium text-ink-900">1. Scan or enter this secret in your authenticator app</p>
              <pre className="mt-2 overflow-x-auto rounded bg-ink-50 p-2 text-xs">{setup.secret}</pre>
              <p className="mt-1 break-all text-xs text-ink-500">{setup.otpauthUrl}</p>
              <div className="mt-3 flex items-end gap-2">
                <div className="flex-1">
                  <Field label="2. Enter the 6-digit code" htmlFor="totp-code">
                    <Input id="totp-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456" />
                  </Field>
                </div>
                <Button variant="primary" loading={busy} onClick={() => void enable()} disabled={code.length < 6}>
                  Enable
                </Button>
              </div>
            </div>
          )}

          {recovery && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">Recovery codes — store these now</p>
              <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900">
                {recovery.map((recoveryCode) => (
                  <span key={recoveryCode}>{recoveryCode}</span>
                ))}
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}

          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Encryption</dt>
              <dd className="text-sm text-ink-800">{data?.encryptionAtRest}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Sessions</dt>
              <dd className="text-sm text-ink-800">
                {data?.sessionPolicy.accessTokenMinutes}-minute access tokens · {data?.sessionPolicy.refreshDays}-day refresh
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent sign-ins" />
        <ul className="divide-y divide-ink-100">
          {(data?.recentLogins ?? []).map((login, index) => (
            <li key={`${login.created_at}-${index}`} className="px-4 py-2.5 text-xs">
              <p className="font-medium text-ink-800">{login.email}</p>
              <p className="text-ink-500">
                {formatDateTime(login.created_at)} · {login.ip} · {login.success ? 'success' : 'failed'}
              </p>
            </li>
          ))}
          {!(data?.recentLogins ?? []).length && <li className="px-4 py-6 text-center text-xs text-ink-500">No sign-ins recorded.</li>}
        </ul>
      </Card>

      <Card className="lg:col-span-3 overflow-hidden">
        <CardHeader title="Active sessions" description="Revoke any session that is not yours." />
        <Table caption="Sessions">
          <THead>
            <tr>
              <TH>Device</TH>
              <TH>IP</TH>
              <TH>Started</TH>
              <TH>Expires</TH>
              <TH>Actions</TH>
            </tr>
          </THead>
          <tbody>
            {(sessions?.data ?? []).map((session) => (
              <TR key={session.id}>
                <TD className="max-w-72 truncate text-xs">{session.user_agent ?? 'Unknown device'}</TD>
                <TD className="text-xs">{session.ip ?? '—'}</TD>
                <TD className="text-xs">{formatDateTime(session.created_at)}</TD>
                <TD className="text-xs">{formatDate(session.expires_at)}</TD>
                <TD>
                  {session.revoked_at ? (
                    <span className="text-xs text-ink-500">Revoked</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-700"
                      onClick={async () => {
                        try {
                          await api.delete(`/auth/sessions/${session.id}`);
                          toast.success('Session revoked');
                          reloadSessions();
                        } catch (err) {
                          toast.error('Could not revoke session', errorMessage(err));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- billing */

function BillingTab(): React.JSX.Element {
  const { session } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const { data, loading, reload } = useQuery<{
    subscription: { plan: string; status: string; seats: number; price_cents: number; current_period_end: string };
    seats: number;
    plans: Array<{ code: string; name: string; priceCents: number; seats: number; features: string[] }>;
  }>('/subscription');
  const { data: usage } = useQuery<{ counts: Record<string, number>; limits: Record<string, number> }>('/usage');
  const [busy, setBusy] = useState<string | null>(null);

  const change = async (plan: string) => {
    setBusy(plan);
    try {
      await api.post('/subscription/change', { plan });
      toast.success('Plan updated');
      reload();
    } catch (err) {
      toast.error('Could not change plan', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <TableSkeleton rows={4} columns={3} />;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-500">Current plan</p>
            <p className="mt-1 text-lg font-semibold capitalize text-ink-900">
              {data?.subscription.plan} · {formatMoney(data?.subscription.price_cents ?? 0, currency)}/month
            </p>
            <p className="text-xs text-ink-500">
              {data?.seats} seats · renews {formatDate(data?.subscription.current_period_end)}
            </p>
          </div>
          <StatusBadge status={data?.subscription.status ?? 'active'} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {['members', 'invoices', 'journal_entries'].map((key) => (
            <div key={key}>
              <ProgressBar
                value={usage?.counts[key] ?? 0}
                max={usage?.limits[key] ?? Math.max(100, (usage?.counts[key] ?? 0) * 2)}
                label={`${titleCase(key.replace('_', ' '))}: ${usage?.counts[key] ?? 0}`}
              />
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {(data?.plans ?? []).map((plan) => {
          const current = plan.code === data?.subscription.plan;
          return (
            <Card key={plan.code} className={`p-5 ${current ? 'ring-2 ring-brand-600' : ''}`}>
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-semibold text-ink-900">{plan.name}</h2>
                {current && <span className="badge bg-brand-100 text-brand-800">Current</span>}
              </div>
              <p className="mt-2 text-2xl font-semibold text-ink-900">
                {formatMoney(plan.priceCents, currency)}
                <span className="text-xs font-normal text-ink-500">/mo</span>
              </p>
              <p className="text-xs text-ink-500">{plan.seats} included seats</p>
              <ul className="mt-3 space-y-1 text-xs text-ink-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-1.5">
                    <span aria-hidden="true" className="text-brand-600">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-4 w-full"
                variant={current ? 'secondary' : 'primary'}
                disabled={current}
                loading={busy === plan.code}
                onClick={() => void change(plan.code)}
              >
                {current ? 'Current plan' : 'Switch to this plan'}
              </Button>
            </Card>
          );
        })}
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Payment method</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-500">
          Billing is handled by the payment provider with tokenised cards — LedgerLine never stores card numbers, which keeps
          this application in PCI DSS SAQ A scope.
        </p>
        <Button className="mt-3" variant="secondary" disabled>
          Update payment method (provider hosted)
        </Button>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- privacy */

function PrivacyTab(): React.JSX.Element {
  const { data, reload } = useQuery<{ data: Array<{ id: string; request_type: string; status: string; requested_at: string; completed_at: string | null }> }>('/gdpr/requests');
  const [busy, setBusy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [exportData, setExportData] = useState<unknown>(null);

  const requestExport = async () => {
    setBusy(true);
    try {
      const result = await api.post<Record<string, unknown>>('/gdpr/export', {});
      setExportData(result);
      toast.success('Export ready', 'Download the JSON below. It contains your personal data.');
      reload();
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const erase = async () => {
    setBusy(true);
    try {
      await api.post('/gdpr/erase', { confirm: true });
      toast.success('Erasure requested', 'Personal data was anonymised; financial records are retained as required by law.');
      setConfirmErase(false);
      reload();
    } catch (err) {
      toast.error('Erasure failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Export your data" description="A machine-readable copy of your personal data and activity." />
        <div className="space-y-3 p-5">
          <p className="text-sm text-ink-600">
            Exports include your profile, memberships and audit activity. Company financial records are excluded because they
            belong to the company.
          </p>
          <Button variant="primary" loading={busy} onClick={() => void requestExport()}>
            Request export
          </Button>
          {exportData !== null && (
            <div>
              <pre className="max-h-56 overflow-auto rounded-lg bg-ink-900 p-3 text-xs text-brand-100">{JSON.stringify(exportData, null, 2)}</pre>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'ledgerline-personal-data.json';
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download JSON
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Erase personal data" description="Right to erasure (GDPR Art. 17)." />
        <div className="space-y-3 p-5">
          <p className="text-sm text-ink-600">
            Erasure anonymises your profile and memberships. Invoices, payments and journal entries are retained in anonymised
            form to meet statutory record-keeping duties.
          </p>
          <Button variant="danger" onClick={() => setConfirmErase(true)}>
            Request erasure
          </Button>
        </div>
      </Card>

      <Card className="lg:col-span-2 overflow-hidden">
        <CardHeader title="Data subject requests" />
        <Table caption="Data subject requests">
          <THead>
            <tr>
              <TH>Request</TH>
              <TH>Status</TH>
              <TH>Requested</TH>
              <TH>Completed</TH>
            </tr>
          </THead>
          <tbody>
            {(data?.data ?? []).map((request) => (
              <TR key={request.id}>
                <TD className="capitalize">{request.request_type}</TD>
                <TD>
                  <StatusBadge status={request.status === 'completed' ? 'paid' : 'pending'} label={request.status} />
                </TD>
                <TD className="text-xs">{formatDateTime(request.requested_at)}</TD>
                <TD className="text-xs">{request.completed_at ? formatDateTime(request.completed_at) : '—'}</TD>
              </TR>
            ))}
            {!(data?.data ?? []).length && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-ink-500">
                  No requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      <ConfirmDialog
        open={confirmErase}
        title="Erase your personal data?"
        description="This cannot be undone. Your name and email are replaced with anonymised values; financial records stay for compliance."
        confirmLabel="Erase my data"
        destructive
        loading={busy}
        onConfirm={() => void erase()}
        onClose={() => setConfirmErase(false)}
      />
    </div>
  );
}

/* --------------------------------------------------------------- profile */

function ProfileTab(): React.JSX.Element {
  const { session } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberships] = useState(session?.memberships ?? []);

  const changePassword = async () => {
    setError(null);
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/account/password', { currentPassword: current, newPassword: next });
      toast.success('Password updated', 'Other sessions were signed out.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Your profile" />
        <dl className="space-y-3 p-5 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Name</dt>
            <dd className="font-medium text-ink-900">{session?.user.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Email</dt>
            <dd className="font-medium text-ink-900">{session?.user.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Role in this company</dt>
            <dd className="font-medium capitalize text-ink-900">{session?.role}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Companies</dt>
            <dd className="text-ink-700">{memberships.map((membership) => membership.tenant.name).join(', ') || session?.tenant.name}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Change password" description="You will stay signed in on this device." />
        <div className="space-y-3 p-5">
          <Field label="Current password" htmlFor="current-password">
            <Input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
          </Field>
          <Field label="New password" htmlFor="new-password" hint="At least 10 characters with upper, lower, number and symbol.">
            <Input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </Field>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" loading={busy} onClick={() => void changePassword()}>
            Update password
          </Button>
        </div>
      </Card>
    </div>
  );
}
