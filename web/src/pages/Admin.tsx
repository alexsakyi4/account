import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatDateTime, formatMoney, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Input,
  PageHeader,
  Select,
  StatCard,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  industry: string;
  base_currency: string;
  is_sandbox: number;
  created_at: string;
  users: number;
  invoices: number;
  invoiced: number;
  mrr: number | null;
}

export function AdminPage(): React.JSX.Element {
  const { session } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<TenantRow | null>(null);

  const { data: metrics, error: metricsError, reload: reloadMetrics } = useQuery<{
    tenants: number;
    active_tenants: number;
    users: number;
    invoices: number;
    journal_entries: number;
    mrr_cents: number;
    mrr: string;
    trials: number;
    signups: Array<{ month: string; count: number }>;
    planMix: Array<{ plan: string; count: number }>;
    health: { database: string; uptimeHours: number };
  }>('/admin/metrics');
  const { data: tenants, loading, error, reload } = useQuery<{ data: TenantRow[]; pagination?: { total: number } }>('/admin/tenants', {
    status,
    q: search || undefined,
    pageSize: 50,
  });
  const { data: health } = useQuery<{ database: { dialect: string; latencyMs: number }; queue: { pending: number; failed: number }; runtime: { node: string; uptimeSeconds: number; memoryMb: number } }>('/admin/health');
  const { data: audit } = useQuery<{ data: Array<{ id: string; action: string; summary: string; actor_email: string | null; created_at: string }> }>('/admin/audit');

  if (metricsError) {
    return (
      <>
        <PageHeader title="Platform admin" description="Restricted to LedgerLine platform administrators." />
        <Card>
          <ErrorState message="Your account does not have platform administrator access." onRetry={reloadMetrics} />
        </Card>
      </>
    );
  }

  const suspend = async () => {
    if (!suspendTarget) return;
    setBusy(true);
    try {
      await api.patch(`/admin/tenants/${suspendTarget.id}`, {
        status: suspendTarget.status === 'suspended' ? 'active' : 'suspended',
        reason: suspendTarget.status === 'suspended' ? 'Reactivated by support' : 'Suspended from admin console',
      });
      toast.success(suspendTarget.status === 'suspended' ? 'Tenant reactivated' : 'Tenant suspended');
      setSuspendTarget(null);
      reload();
      reloadMetrics();
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const impersonate = async (tenant: TenantRow) => {
    try {
      const result = await api.post<{ accessToken: string; warning: string }>(`/admin/tenants/${tenant.id}/impersonate`, {});
      localStorage.setItem(`ledgerline.support.${tenant.id}`, result.accessToken);
      toast.success('Support session issued', result.warning);
    } catch (err) {
      toast.error('Could not start support session', errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Platform admin"
        description="Tenants, health and platform-level audit. Support access is time-limited and logged."
        actions={<span className="badge bg-ink-900 text-white">{session?.user.email}</span>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active tenants" value={String(metrics?.active_tenants ?? '—')} hint={`${metrics?.tenants ?? 0} total`} />
        <StatCard label="MRR" value={metrics?.mrr ? `$${metrics.mrr}` : '—'} hint={`${metrics?.trials ?? 0} trials`} />
        <StatCard label="Users" value={String(metrics?.users ?? '—')} hint={`${metrics?.invoices ?? 0} invoices issued`} />
        <StatCard label="Journal entries" value={String(metrics?.journal_entries ?? '—')} hint={`${health?.queue.pending ?? 0} queued webhooks`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader title="Tenants" description="Search, inspect usage and manage access." />
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 px-4 py-2">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or slug" aria-label="Search tenants" className="w-56 py-1.5 text-xs" />
            <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Tenant status" className="w-36 py-1.5 text-xs">
              {['all', 'active', 'suspended'].map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
          </div>
          {loading && !tenants ? (
            <TableSkeleton rows={5} columns={5} />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <Table caption="Tenants">
              <THead>
                <tr>
                  <TH>Company</TH>
                  <TH>Plan</TH>
                  <TH numeric>Users</TH>
                  <TH numeric>Invoiced</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </tr>
              </THead>
              <tbody>
                {(tenants?.data ?? []).map((tenant) => (
                  <TR key={tenant.id}>
                    <TD>
                      <p className="font-medium text-ink-900">{tenant.name}</p>
                      <p className="text-xs text-ink-500">
                        {tenant.slug} · joined {formatDate(tenant.created_at.slice(0, 10), 'short')}
                      </p>
                    </TD>
                    <TD className="capitalize">{tenant.plan}</TD>
                    <TD numeric>{tenant.users}</TD>
                    <TD numeric>{formatMoney(tenant.invoiced, tenant.base_currency)}</TD>
                    <TD>
                      <StatusBadge status={tenant.status === 'suspended' ? 'void' : 'active'} label={titleCase(tenant.status)} />
                    </TD>
                    <TD>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void impersonate(tenant)}>
                          Support access
                        </Button>
                        <Button size="sm" variant="ghost" className={tenant.status === 'suspended' ? '' : 'text-red-700'} onClick={() => setSuspendTarget(tenant)}>
                          {tenant.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="System health" />
            <dl className="space-y-3 p-5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-500">Database</dt>
                <dd className="font-medium capitalize text-ink-900">
                  {health?.database.dialect ?? '—'} ({health?.database.latencyMs ?? 0} ms)
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Runtime</dt>
                <dd className="font-medium text-ink-900">{health?.runtime.node ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Uptime</dt>
                <dd className="font-medium text-ink-900">{Math.round((health?.runtime.uptimeSeconds ?? 0) / 3600)}h</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Webhook queue</dt>
                <dd className="font-medium text-ink-900">
                  {health?.queue.pending ?? 0} pending · {health?.queue.failed ?? 0} failed
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Memory</dt>
                <dd className="font-medium text-ink-900">{health?.runtime.memoryMb ?? 0} MB</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Plan mix" />
            <ul className="space-y-2 p-5 text-sm">
              {(metrics?.planMix ?? []).map((row) => (
                <li key={row.plan} className="flex justify-between">
                  <span className="capitalize text-ink-600">{row.plan}</span>
                  <span className="font-medium text-ink-900">{row.count}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Platform audit" description="Support access and tenant state changes." />
        <Table caption="Platform audit log">
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Actor</TH>
              <TH>Action</TH>
              <TH>Summary</TH>
            </tr>
          </THead>
          <tbody>
            {(audit?.data ?? []).map((row) => (
              <TR key={row.id}>
                <TD className="text-xs">{formatDateTime(row.created_at)}</TD>
                <TD className="text-xs">{row.actor_email ?? 'system'}</TD>
                <TD>
                  <span className="badge bg-ink-100 font-mono text-[11px]">{row.action}</span>
                </TD>
                <TD className="text-xs">{row.summary}</TD>
              </TR>
            ))}
            {!(audit?.data ?? []).length && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-ink-500">
                  No platform audit entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      <ConfirmDialog
        open={suspendTarget !== null}
        title={suspendTarget?.status === 'suspended' ? `Reactivate ${suspendTarget?.name}?` : `Suspend ${suspendTarget?.name}?`}
        description={
          suspendTarget?.status === 'suspended'
            ? 'Users regain access immediately and the change is recorded.'
            : 'All sessions are revoked and sign-in is blocked. Data is retained. This is logged in the platform audit trail.'
        }
        confirmLabel={suspendTarget?.status === 'suspended' ? 'Reactivate' : 'Suspend tenant'}
        destructive={suspendTarget?.status !== 'suspended'}
        loading={busy}
        onConfirm={() => void suspend()}
        onClose={() => setSuspendTarget(null)}
      />
    </>
  );
}
