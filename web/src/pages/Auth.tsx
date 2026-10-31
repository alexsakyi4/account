import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, toast } from '../lib/data';
import { useSession } from '../lib/session';
import { Button, Field, Input, Select } from '../components/ui';

const INDUSTRIES = [
  { value: 'services', label: 'Professional services' },
  { value: 'retail', label: 'Retail & e-commerce' },
  { value: 'wholesale', label: 'Wholesale & distribution' },
  { value: 'construction', label: 'Construction & trades' },
  { value: 'restaurant', label: 'Food & beverage' },
  { value: 'nonprofit', label: 'Non-profit' },
  { value: 'technology', label: 'Technology & SaaS' },
];

function AuthLayout({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-[1.05fr_1fr]">
      <div className="hidden flex-col justify-between bg-ink-900 p-12 text-white lg:flex">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-brand-300">LL</span>
          <span className="text-lg font-semibold tracking-tight">LedgerLine</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Books that close on time, every month.</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-300">
            Double-entry accounting with invoicing, bills, bank reconciliation, inventory and reporting — built for small
            businesses and their accountants.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-ink-200">
            {[
              'Invoice to cash in one flow, with partial payments and credit memos',
              'Bank feeds, rule-based matching and a reconciliation you can trust',
              'Immutable audit trail, role-based access and 2FA for admins',
              'Reports, CSV/PDF exports and a documented REST API',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="text-brand-400">
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-ink-400">
          Original software — no third-party accounting trademarks, logos or proprietary workflows.
        </p>
      </div>
      <div className="flex min-h-screen flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-900 text-sm font-bold text-brand-300">LL</span>
            <span className="text-lg font-semibold tracking-tight text-ink-900">LedgerLine</span>
          </div>
          {children}
          {footer}
        </div>
      </div>
    </div>
  );
}

export function LoginPage(): React.JSX.Element {
  const { login, session, loginDemo } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session) navigate('/', { replace: true });
  }, [session, navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password, totp || undefined);
      if (result.requires2fa) {
        setNeeds2fa(true);
        toast.info('Enter your 2FA code', 'Two-factor authentication is enabled for this account.');
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginDemo();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      footer={
        <p className="mt-6 text-center text-sm text-ink-500">
          New here?{' '}
          <Link to="/register" className="font-semibold text-brand-800 hover:underline">
            Create a company account
          </Link>
        </p>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Sign in</h1>
      <p className="mt-1 text-sm text-ink-500">Use your work email to access your company books.</p>

      <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
        <Field label="Work email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••"
          />
        </Field>
        {needs2fa && (
          <Field label="Authentication code" htmlFor="totp" hint="Six-digit code from your authenticator app, or a recovery code.">
            <Input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
              placeholder="123456"
              autoFocus
            />
          </Field>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {needs2fa ? 'Verify and sign in' : 'Sign in'}
        </Button>
      </form>

      <div className="mt-4 flex items-center justify-between text-sm">
        <Link to="/forgot-password" className="text-ink-600 hover:text-ink-900 hover:underline">
          Forgot password?
        </Link>
        <button type="button" onClick={demo} className="font-medium text-brand-800 hover:underline" disabled={busy}>
          Explore the demo company
        </button>
      </div>

      <div className="mt-8 rounded-lg border border-ink-200 bg-ink-50 p-4 text-xs text-ink-600">
        <p className="font-semibold text-ink-800">Demo credentials</p>
        <p className="mt-1">
          <code className="rounded bg-white px-1 py-0.5">demo@ledgerline.app</code> /{' '}
          <code className="rounded bg-white px-1 py-0.5">DemoPass123!</code>
        </p>
        <p className="mt-1 text-ink-500">The demo tenant is a sandbox with sample invoices, bills and a bank feed.</p>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage(): React.JSX.Element {
  const { register, session } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyName: '',
    name: '',
    email: '',
    password: '',
    industry: 'services',
    currency: 'USD',
    sampleData: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session) navigate('/', { replace: true });
  }, [session, navigate]);

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(form);
      toast.success('Company created', 'Your chart of accounts and defaults are ready.');
      navigate('/onboarding', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      footer={
        <p className="mt-6 text-center text-sm text-ink-500">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-800 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Create your company</h1>
      <p className="mt-1 text-sm text-ink-500">We&apos;ll set up a chart of accounts, taxes and number sequences for you.</p>
      <form onSubmit={submit} className="mt-7 space-y-4">
        <Field label="Company name" htmlFor="company">
          <Input id="company" required minLength={3} value={form.companyName} onChange={update('companyName')} placeholder="Lakeside Trading Co." />
        </Field>
        <Field label="Your name" htmlFor="name">
          <Input id="name" required minLength={3} autoComplete="name" value={form.name} onChange={update('name')} placeholder="Ada Lovelace" />
        </Field>
        <Field label="Work email" htmlFor="reg-email">
          <Input id="reg-email" type="email" required autoComplete="email" value={form.email} onChange={update('email')} placeholder="you@company.com" />
        </Field>
        <Field label="Password" htmlFor="reg-password" hint="At least 10 characters with upper, lower, number and symbol.">
          <Input
            id="reg-password"
            type="password"
            required
            autoComplete="new-password"
            value={form.password}
            onChange={update('password')}
            placeholder="••••••••••"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry" htmlFor="industry">
            <Select id="industry" value={form.industry} onChange={update('industry')}>
              {INDUSTRIES.map((industry) => (
                <option key={industry.value} value={industry.value}>
                  {industry.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="currency">
            <Select id="currency" value={form.currency} onChange={update('currency')}>
              {['USD', 'EUR', 'GBP', 'GHS', 'NGN', 'KES', 'CAD', 'AUD', 'ZAR', 'INR'].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-700">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-700"
            checked={form.sampleData}
            onChange={(event) => setForm((current) => ({ ...current, sampleData: event.target.checked }))}
          />
          <span>
            <span className="font-medium text-ink-900">Add sample data</span> — customers, invoices and a bank feed to practise
            with. You can reset or delete it later.
          </span>
        </label>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create company
        </Button>
        <p className="text-center text-xs text-ink-500">
          By continuing you agree to the terms of service and privacy notice.
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/password/reset-request', { email });
      setSent(true);
    } catch {
      setSent(true); // do not reveal whether the address exists
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      footer={
        <p className="mt-6 text-center text-sm text-ink-500">
          <Link to="/login" className="font-semibold text-brand-800 hover:underline">
            Back to sign in
          </Link>
        </p>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-500">We&apos;ll email a single-use link that expires in 30 minutes.</p>
      {sent ? (
        <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900" role="status">
          If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your spam folder if it does not
          arrive within a few minutes.
        </div>
      ) : (
        <form onSubmit={submit} className="mt-7 space-y-4">
          <Field label="Work email" htmlFor="reset-email">
            <Input id="reset-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function AcceptInvitePage(): React.JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const token = params.get('token') ?? '';
  const [form, setForm] = useState({ name: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ accessToken: string; refreshToken?: string }>('/auth/accept-invite', {
        token,
        name: form.name,
        password: form.password,
      });
      localStorage.setItem('ledgerline.accessToken', result.accessToken);
      if (result.refreshToken) localStorage.setItem('ledgerline.refreshToken', result.refreshToken);
      await refresh();
      toast.success('Welcome aboard', 'Your account is ready.');
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Accept your invitation</h1>
      <p className="mt-1 text-sm text-ink-500">Choose a name and password to join your company&apos;s books.</p>
      {!token && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
          This invite link is missing its token. Ask an administrator to resend it.
        </p>
      )}
      <form onSubmit={submit} className="mt-7 space-y-4">
        <Field label="Your name" htmlFor="invite-name">
          <Input id="invite-name" required minLength={3} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Password" htmlFor="invite-password" hint="At least 10 characters with upper, lower, number and symbol.">
          <Input
            id="invite-password"
            type="password"
            required
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
        </Field>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!token}>
          Join company
        </Button>
      </form>
    </AuthLayout>
  );
}
