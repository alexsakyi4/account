import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '../lib/data';
import { classNames, initials } from '../lib/format';
import { useSession } from '../lib/session';
import { Button, ProgressBar, Spinner } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission?: string;
  flag?: string;
  badgeKey?: 'invoices' | 'bills' | 'bank';
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: '◱' },
      { to: '/onboarding', label: 'Get set up', icon: '◈' },
    ],
  },
  {
    title: 'Sales',
    items: [
      { to: '/invoices', label: 'Invoices & estimates', icon: '▤', permission: 'invoices:write', badgeKey: 'invoices' },
      { to: '/recurring', label: 'Recurring', icon: '↻', permission: 'invoices:write' },
      { to: '/customers', label: 'Customers', icon: '☺' },
    ],
  },
  {
    title: 'Purchases',
    items: [
      { to: '/bills', label: 'Bills', icon: '▥', permission: 'bills:write', badgeKey: 'bills' },
      { to: '/expenses', label: 'Expenses', icon: '◫' },
      { to: '/vendors', label: 'Vendors', icon: '⌂' },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/banking', label: 'Banking', icon: '⌸', badgeKey: 'bank' },
      { to: '/payments', label: 'Payments', icon: '⇄' },
    ],
  },
  {
    title: 'Accounting',
    items: [
      { to: '/accounts', label: 'Chart of accounts', icon: '≡' },
      { to: '/journal', label: 'Journal', icon: '⧉' },
      { to: '/reports', label: 'Reports', icon: '◲', permission: 'reports:read' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { to: '/inventory', label: 'Inventory', icon: '▦', flag: 'inventory' },
      { to: '/payroll', label: 'Payroll', icon: '☰', flag: 'payroll' },
      { to: '/import', label: 'Import & export', icon: '⇧', permission: 'import:write' },
      { to: '/settings', label: 'Settings', icon: '⚙' },
    ],
  },
];

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function AppShell(): React.JSX.Element {
  const { session, logout, can, featureEnabled, isRole } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const paletteRef = useRef<HTMLInputElement>(null);
  const pendingKey = useRef<string | null>(null);

  const { data: onboarding } = useQuery<{ completed: number; data: Array<{ step_key: string; completed_at: string | null }> }>('/onboarding');
  const { data: dashboard } = useQuery<{ counts?: { invoices: number; bills: number }; overdueInvoices?: Array<{ id: string }> }>(
    location.pathname === '/' ? null : '/reports/dashboard',
  );

  useEffect(() => {
    setMobileOpen(false);
    setUserMenuOpen(false);
  }, [location.pathname]);

  const badges = useMemo(
    () => ({
      invoices: dashboard?.overdueInvoices?.length ?? 0,
      bills: 0,
      bank: 0,
    }),
    [dashboard],
  );

  const paletteActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = [
      { id: 'new-invoice', label: 'New invoice', hint: 'Create and send an invoice', run: () => navigate('/invoices?new=1') },
      { id: 'new-bill', label: 'New bill', hint: 'Record a vendor bill', run: () => navigate('/bills?new=1') },
      { id: 'new-expense', label: 'New expense', hint: 'Submit an expense with a receipt', run: () => navigate('/expenses?new=1') },
      { id: 'new-journal', label: 'New journal entry', hint: 'Manual double-entry adjustment', run: () => navigate('/journal?new=1') },
      { id: 'reconcile', label: 'Reconcile a bank account', hint: 'Match statement lines', run: () => navigate('/banking') },
      { id: 'reports', label: 'Open reports', hint: 'P&L, balance sheet, aging', run: () => navigate('/reports') },
      { id: 'close', label: 'Month-end close', hint: 'Lock the period', run: () => navigate('/settings?tab=periods') },
      { id: 'import', label: 'Import data', hint: 'QuickBooks CSV and templates', run: () => navigate('/import') },
      { id: 'security', label: 'Security & 2FA', hint: 'Protect admin accounts', run: () => navigate('/settings?tab=security') },
    ];
    for (const group of NAV) {
      for (const item of group.items) {
        if (item.permission && !can(item.permission)) continue;
        if (item.flag && !featureEnabled(item.flag)) continue;
        actions.push({ id: `nav-${item.to}`, label: item.label, hint: group.title, run: () => navigate(item.to) });
      }
    }
    return actions;
  }, [can, featureEnabled, navigate]);

  const filteredActions = useMemo(() => {
    if (!paletteQuery.trim()) return paletteActions.slice(0, 9);
    const q = paletteQuery.toLowerCase();
    return paletteActions.filter((action) => `${action.label} ${action.hint}`.toLowerCase().includes(q)).slice(0, 9);
  }, [paletteActions, paletteQuery]);

  const openPalette = useCallback(() => {
    setPaletteQuery('');
    setPaletteOpen(true);
    setTimeout(() => paletteRef.current?.focus(), 30);
  }, []);

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-search-input]');
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (event.key === 'g') {
        pendingKey.current = 'g';
        setTimeout(() => {
          pendingKey.current = null;
        }, 900);
        return;
      }
      if (pendingKey.current === 'g') {
        const map: Record<string, string> = { d: '/', i: '/invoices', b: '/bills', c: '/customers', r: '/reports', a: '/accounts', j: '/journal', k: '/banking', s: '/settings' };
        const target = map[event.key.toLowerCase()];
        if (target) {
          event.preventDefault();
          navigate(target);
        }
        pendingKey.current = null;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, openPalette]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutsOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [shortcutsOpen]);

  if (!session) return <div />;

  const steps = onboarding?.data ?? [];
  const completed = onboarding?.completed ?? 0;
  const showSetup = steps.length > 0 && completed >= steps.length;

  return (
    <div className="min-h-screen bg-ink-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-ink-900 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-200 bg-white px-4 py-2.5 lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="btn-secondary px-2 py-1.5"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
        >
          ☰
        </button>
        <span className="font-semibold text-ink-900">LedgerLine</span>
        <button onClick={openPalette} className="btn-secondary px-2 py-1.5" aria-label="Open command palette">
          ⌘K
        </button>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside
          className={classNames(
            'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-200 bg-white transition-transform lg:static lg:translate-x-0',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          aria-label="Primary"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <a href="/" className="flex items-center gap-2" onClick={(event) => (event.preventDefault(), navigate('/'))}>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-900 text-sm font-bold text-brand-300" aria-hidden="true">
                LL
              </span>
              <span className="text-base font-semibold tracking-tight text-ink-900">LedgerLine</span>
            </a>
            <button onClick={() => setMobileOpen(false)} className="btn-ghost px-1.5 py-1 lg:hidden" aria-label="Close navigation">
              ×
            </button>
          </div>

          <div className="px-3">
            <button
              onClick={openPalette}
              className="mb-3 flex w-full items-center justify-between rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-500 hover:border-ink-300"
            >
              <span className="flex items-center gap-2">
                <span aria-hidden="true">⌕</span> Jump to…
              </span>
              <kbd className="rounded border border-ink-300 bg-white px-1 py-0.5 text-[10px] text-ink-500">⌘K</kbd>
            </button>
          </div>

          <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
            {NAV.map((group) => {
              const items = group.items.filter((item) => {
                if (item.permission && !can(item.permission)) return false;
                if (item.flag && !featureEnabled(item.flag)) return false;
                return true;
              });
              if (!items.length) return null;
              return (
                <div key={group.title}>
                  <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{group.title}</p>
                  <ul className="space-y-0.5">
                    {items.map((item) => (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          className={({ isActive }) =>
                            classNames(
                              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition',
                              isActive ? 'bg-brand-50 text-brand-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                            )
                          }
                        >
                          <span aria-hidden="true" className="w-4 text-center text-ink-400">
                            {item.icon}
                          </span>
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.badgeKey && badges[item.badgeKey] > 0 && (
                            <span className="rounded-full bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">
                              {badges[item.badgeKey]}
                            </span>
                          )}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {isRole('admin') && session.user.isPlatformAdmin && (
              <div>
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Platform</p>
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    classNames(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium',
                      isActive ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100',
                    )
                  }
                >
                  <span aria-hidden="true" className="w-4 text-center">
                    ◇
                  </span>
                  Admin console
                </NavLink>
              </div>
            )}
          </nav>

          {!showSetup && steps.length > 0 && (
            <div className="mx-3 mb-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
              <p className="text-xs font-semibold text-brand-900">Finish setting up</p>
              <p className="mt-0.5 text-xs text-brand-800">
                {completed} of {steps.length} steps complete
              </p>
              <div className="mt-2">
                <ProgressBar value={completed} max={steps.length} label="Setup progress" />
              </div>
              <button onClick={() => navigate('/onboarding')} className="mt-2 text-xs font-semibold text-brand-800 underline">
                Resume setup
              </button>
            </div>
          )}

          <div className="border-t border-ink-200 p-3">
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen((open) => !open)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-ink-100"
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-white">
                  {initials(session.user.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-900">{session.user.name}</span>
                  <span className="block truncate text-xs capitalize text-ink-500">
                    {session.role} · {session.tenant.name}
                  </span>
                </span>
                <span aria-hidden="true" className="text-ink-400">
                  ⌄
                </span>
              </button>
              {userMenuOpen && (
                <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-ink-200 bg-white py-1 shadow-lg" role="menu">
                  <button
                    className="block w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-100"
                    role="menuitem"
                    onClick={() => navigate('/settings?tab=profile')}
                  >
                    Profile & security
                  </button>
                  <button
                    className="block w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-100"
                    role="menuitem"
                    onClick={() => {
                      setShortcutsOpen(true);
                      setUserMenuOpen(false);
                    }}
                  >
                    Keyboard shortcuts
                    <kbd className="float-right rounded border border-ink-300 px-1 text-[10px]">?</kbd>
                  </button>
                  <button
                    className="block w-full px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                    role="menuitem"
                    onClick={() => void logout().then(() => navigate('/login'))}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>

        {mobileOpen && (
          <button
            className="fixed inset-0 z-30 bg-ink-900/30 lg:hidden"
            aria-label="Close navigation overlay"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* Main */}
        <div className="min-w-0 flex-1">
          <div className="sticky top-0 z-20 hidden items-center justify-between gap-4 border-b border-ink-200 bg-white/90 px-6 py-2.5 backdrop-blur lg:flex">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-sm font-medium text-ink-800">{session.tenant.name}</span>
              {session.tenant.isSandbox && (
                <span className="badge bg-violet-100 text-violet-800" title="This tenant is a sandbox with sample data">
                  Sandbox
                </span>
              )}
              {session.memberships.length > 1 && (
                <select
                  className="input max-w-48 py-1 text-xs"
                  aria-label="Switch company"
                  value={session.tenant.id}
                  onChange={(event) => {
                    const target = session.memberships.find((m) => m.tenant.id === event.target.value);
                    if (target) window.location.assign(`/switch?tenant=${target.tenant.id}`);
                  }}
                >
                  {session.memberships.map((membership) => (
                    <option key={membership.tenant.id} value={membership.tenant.id}>
                      {membership.tenant.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-ink-500">
              <button onClick={openPalette} className="rounded-md border border-ink-200 px-2 py-1 hover:bg-ink-100">
                Search <kbd className="ml-1 text-[10px]">⌘K</kbd>
              </button>
              <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="hover:text-ink-800 hover:underline">
                API docs
              </a>
              <button onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts" className="rounded-md border border-ink-200 px-2 py-1">
                ?
              </button>
            </div>
          </div>

          <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Command palette */}
      {paletteOpen && (
        <div className="fixed inset-0 z-[65] flex items-start justify-center bg-ink-900/40 px-4 pt-24" role="presentation">
          <button className="fixed inset-0 cursor-default" aria-hidden="true" tabIndex={-1} onClick={() => setPaletteOpen(false)} />
          <div
            className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-2 border-b border-ink-100 px-4">
              <span aria-hidden="true" className="text-ink-400">
                ⌕
              </span>
              <input
                ref={paletteRef}
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setPaletteOpen(false);
                  if (event.key === 'Enter') {
                    filteredActions[0]?.run();
                    setPaletteOpen(false);
                  }
                }}
                placeholder="Search actions and pages…"
                aria-label="Search actions and pages"
                className="w-full border-0 bg-transparent py-3 text-sm outline-none focus:ring-0"
              />
              <kbd className="rounded border border-ink-300 px-1.5 py-0.5 text-[10px] text-ink-500">esc</kbd>
            </div>
            <ul className="max-h-80 overflow-y-auto py-1">
              {filteredActions.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-500">No matches</li>}
              {filteredActions.map((action) => (
                <li key={action.id}>
                  <button
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-brand-50"
                    onClick={() => {
                      action.run();
                      setPaletteOpen(false);
                    }}
                  >
                    <span className="font-medium text-ink-800">{action.label}</span>
                    <span className="text-xs text-ink-500">{action.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div className="fixed inset-0 z-[66] flex items-center justify-center bg-ink-900/40 p-4" role="presentation">
          <button className="fixed inset-0 cursor-default" aria-hidden="true" tabIndex={-1} onClick={() => setShortcutsOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink-900">Keyboard shortcuts</h2>
              <button onClick={() => setShortcutsOpen(false)} className="btn-ghost px-2 py-1 text-lg" aria-label="Close">
                ×
              </button>
            </div>
            <dl className="space-y-2 text-sm">
              {[
                ['⌘K / Ctrl K', 'Command palette'],
                ['g then d', 'Dashboard'],
                ['g then i', 'Invoices'],
                ['g then b', 'Bills'],
                ['g then r', 'Reports'],
                ['g then j', 'Journal'],
                ['g then k', 'Banking'],
                ['/', 'Focus search'],
                ['?', 'This list'],
                ['Esc', 'Close dialog'],
              ].map(([keys, label]) => (
                <div key={keys} className="flex items-center justify-between rounded-md bg-ink-50 px-3 py-1.5">
                  <dt className="text-ink-600">{label}</dt>
                  <dd>
                    <kbd className="rounded border border-ink-300 bg-white px-1.5 py-0.5 font-mono text-xs text-ink-700">{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-ink-500">Shortcuts stay out of the way while you type.</p>
              <Button size="sm" onClick={() => setShortcutsOpen(false)}>
                Got it
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function LoadingScreen({ label = 'Loading LedgerLine…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50">
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <Spinner /> {label}
      </div>
    </div>
  );
}
