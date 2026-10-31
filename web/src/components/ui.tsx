import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { classNames, formatMoney } from '../lib/format';
import { toast, useQuery, type Toast } from '../lib/data';

/* ---------------------------------------------------------------- buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean }): React.JSX.Element {
  const variantClass = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    ghost: 'btn-ghost',
    danger: 'btn-danger',
  }[variant];
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={classNames(variantClass, size === 'sm' && 'px-2.5 py-1.5 text-xs', className)}
      aria-busy={loading || undefined}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={classNames('animate-spin', className ?? 'h-4 w-4')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ forms */

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}): React.JSX.Element {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-0.5 text-red-600" aria-hidden="true">*</span>}
        {required && <span className="sr-only">(required)</span>}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element => (
  <input {...props} className={classNames('input', props.className)} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element => (
  <select {...props} className={classNames('input pr-8', props.className)} />
);

export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element => (
  <textarea {...props} className={classNames('input min-h-20', props.className)} />
);

export function Checkbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={rest.id ?? id} type="checkbox" {...rest} className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-700" />
      <label htmlFor={rest.id ?? id} className="text-sm text-ink-700">
        {label}
      </label>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-ink-900">{label}</p>
        {description && <p className="text-xs text-ink-500">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={classNames(
          'relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700',
          checked ? 'bg-brand-600' : 'bg-ink-300',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={classNames(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}): React.JSX.Element {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1 text-xs text-ink-500">
            <ol className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {crumb.href ? (
                    <a href={crumb.href} className="hover:text-ink-800 hover:underline">
                      {crumb.label}
                    </a>
                  ) : (
                    <span className="text-ink-700">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}): React.JSX.Element {
  return <Tag className={classNames('card', className)}>{children}</Tag>;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
  icon?: ReactNode;
}): React.JSX.Element {
  const toneClass = {
    default: 'text-ink-900',
    positive: 'text-brand-700',
    warning: 'text-amber-700',
    danger: 'text-red-700',
  }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
        {icon && <span aria-hidden="true" className="text-ink-400">{icon}</span>}
      </div>
      <p className={classNames('mt-2 text-2xl font-semibold tabular-nums tracking-tight', toneClass)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} description={description} action={action} />
      <div className="p-5">{children}</div>
    </Card>
  );
}

/* ------------------------------------------------------------------ tables */

export function Table({ children, caption }: { children: ReactNode; caption?: string }): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-ink-200">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }): React.JSX.Element {
  return <thead className="bg-ink-50">{children}</thead>;
}

export function TR({
  children,
  onClick,
  selected,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}): React.JSX.Element {
  const interactive = Boolean(onClick);
  return (
    <tr
      className={classNames(
        'border-b border-ink-100 last:border-0',
        interactive && 'cursor-pointer hover:bg-brand-50/60',
        selected && 'bg-brand-50',
        className,
      )}
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {children}
    </tr>
  );
}

export const TH = ({ children, className, numeric }: { children: ReactNode; className?: string; numeric?: boolean }): React.JSX.Element => (
  <th scope="col" className={classNames('th', numeric && 'text-right', className)}>
    {children}
  </th>
);

export const TD = ({ children, className, numeric }: { children: ReactNode; className?: string; numeric?: boolean }): React.JSX.Element => (
  <td className={classNames('td', numeric && 'text-right tabular-nums', className)}>{children}</td>
);

export function Money({
  amount,
  currency = 'USD',
  className,
  colored,
}: {
  amount: number;
  currency?: string;
  className?: string;
  colored?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={classNames(
        'tabular-nums',
        colored && (amount < 0 ? 'text-red-700' : amount > 0 ? 'text-brand-700' : 'text-ink-500'),
        className,
      )}
    >
      {formatMoney(amount, currency)}
    </span>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }): React.JSX.Element {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <div key={columnIndex} className="skeleton h-6 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-ink-100 text-ink-500" aria-hidden="true">
        {icon ?? '◎'}
      </div>
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center" role="alert">
      <p className="text-sm font-semibold text-red-700">We couldn&apos;t load this view</p>
      <p className="mt-1 max-w-md text-sm text-ink-600">{message}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}): React.JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav className="flex items-center justify-between border-t border-ink-100 px-4 py-3 text-sm" aria-label="Pagination">
      <p className="text-xs text-ink-500">
        Showing <span className="font-medium text-ink-800">{(page - 1) * pageSize + 1}</span>–
        <span className="font-medium text-ink-800">{Math.min(page * pageSize, total)}</span> of{' '}
        <span className="font-medium text-ink-800">{total}</span>
      </p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          Previous
        </Button>
        <span className="px-2 text-xs text-ink-500">
          {page} / {totalPages}
        </span>
        <Button size="sm" variant="secondary" onClick={() => onChange(page + 1)} disabled={page >= totalPages} aria-label="Next page">
          Next
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------- status UI */

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-brand-100 text-brand-800',
  posted: 'bg-brand-100 text-brand-800',
  approved: 'bg-brand-100 text-brand-800',
  active: 'bg-brand-100 text-brand-800',
  completed: 'bg-brand-100 text-brand-800',
  delivered: 'bg-brand-100 text-brand-800',
  matched: 'bg-brand-100 text-brand-800',
  sent: 'bg-sky-100 text-sky-800',
  open: 'bg-sky-100 text-sky-800',
  submitted: 'bg-amber-100 text-amber-800',
  pending: 'bg-amber-100 text-amber-800',
  draft: 'bg-ink-100 text-ink-700',
  partial: 'bg-amber-100 text-amber-800',
  scheduled: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  void: 'bg-ink-200 text-ink-600',
  voided: 'bg-ink-200 text-ink-600',
  excluded: 'bg-ink-200 text-ink-600',
  unmatched: 'bg-amber-100 text-amber-800',
  paused: 'bg-amber-100 text-amber-800',
  ended: 'bg-ink-200 text-ink-600',
  converted: 'bg-violet-100 text-violet-800',
};

export function StatusBadge({ status, label }: { status: string; label?: string }): React.JSX.Element {
  return (
    <span className={classNames('badge', STATUS_STYLES[status] ?? 'bg-ink-100 text-ink-700')}>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: Array<{ id: string; label: string; count?: number; disabled?: boolean }>;
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1 overflow-x-auto border-b border-ink-200">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          disabled={tab.disabled}
          onClick={() => onChange(tab.id)}
          className={classNames(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition',
            value === tab.id
              ? 'border-brand-700 text-brand-800'
              : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800',
            tab.disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {tab.label}
          {typeof tab.count === 'number' && (
            <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-600">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- overlays */

const ModalContext = createContext<{ close: () => void } | null>(null);
export const useModal = (): { close: () => void } => {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used inside <Modal>');
  return ctx;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus(), 40);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];

  return createPortal(
    <ModalContext.Provider value={{ close: onClose }}>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 sm:items-center">
        <button className="fixed inset-0 cursor-default" aria-hidden="true" tabIndex={-1} onClick={onClose} />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className={classNames('relative z-10 w-full rounded-xl bg-white shadow-2xl', width)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-6 py-4">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-ink-900">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-0.5 text-sm text-ink-500">
                  {description}
                </p>
              )}
            </div>
            <button onClick={onClose} className="btn-ghost -mr-2 px-2 py-1 text-lg" aria-label="Close dialog">
              ×
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 px-6 py-4">{footer}</div>}
        </div>
      </div>
    </ModalContext.Provider>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-900/30" role="presentation">
      <button className="flex-1 cursor-default" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button onClick={onClose} className="btn-ghost px-2 py-1 text-lg" aria-label="Close panel">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-ink-100 px-6 py-4">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  onClose,
  loading,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-600">{description}</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ charts */

export function BarChart({
  series,
  height = 160,
  currency,
}: {
  series: Array<{ label: string; income: number; expenses: number }>;
  height?: number;
  currency: string;
}): React.JSX.Element {
  const max = Math.max(1, ...series.flatMap((point) => [point.income, point.expenses]));
  const barWidth = 10;
  const gap = 26;
  const width = Math.max(260, series.length * gap + 24);
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Income and expenses by month: ${series.map((s) => `${s.label} income ${formatMoney(s.income, currency)}, expenses ${formatMoney(s.expenses, currency)}`).join('; ')}`}
      >
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={0}
            x2={width}
            y1={height - 24 - ratio * (height - 40)}
            y2={height - 24 - ratio * (height - 40)}
            stroke="currentColor"
            className="text-ink-100"
            strokeDasharray="3 4"
          />
        ))}
        {series.map((point, index) => {
          const x = 12 + index * gap;
          const incomeHeight = Math.max(point.income > 0 ? 2 : 0, (point.income / max) * (height - 40));
          const expenseHeight = Math.max(point.expenses > 0 ? 2 : 0, (point.expenses / max) * (height - 40));
          return (
            <g key={point.label}>
              <rect
                x={x}
                y={height - 24 - incomeHeight}
                width={barWidth}
                height={incomeHeight}
                rx={2}
                className="fill-brand-600"
              >
                <title>{`${point.label} income ${formatMoney(point.income, currency)}`}</title>
              </rect>
              <rect
                x={x + barWidth + 3}
                y={height - 24 - expenseHeight}
                width={barWidth}
                height={expenseHeight}
                rx={2}
                className="fill-ink-300"
              >
                <title>{`${point.label} expenses ${formatMoney(point.expenses, currency)}`}</title>
              </rect>
              <text x={x} y={height - 8} className="fill-ink-500 text-[9px]">
                {point.label.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex items-center gap-4 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-brand-600" aria-hidden="true" /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-ink-300" aria-hidden="true" /> Expenses
        </span>
      </figcaption>
    </figure>
  );
}

export function ProgressBar({ value, max = 100, label }: { value: number; max?: number; label: string }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-ink-500">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ toasts */

export function Toasts(): React.JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => toast.subscribe(setItems), []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div
          key={item.id}
          className={classNames(
            'pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg',
            item.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-900'
              : item.kind === 'success'
                ? 'border-brand-200 bg-brand-50 text-brand-900'
                : 'border-ink-200 bg-white text-ink-800',
          )}
          role={item.kind === 'error' ? 'alert' : 'status'}
        >
          <span aria-hidden="true">{item.kind === 'error' ? '!' : item.kind === 'success' ? '✓' : 'i'}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{item.title}</p>
            {item.description && <p className="mt-0.5 text-xs opacity-90">{item.description}</p>}
          </div>
          <button onClick={() => toast.dismiss(item.id)} aria-label="Dismiss notification" className="text-xs opacity-60 hover:opacity-100">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

export function HelpTip({ children, text }: { children: ReactNode; text: string }): React.JSX.Element {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <span className="group relative inline-flex">
        <button
          type="button"
          aria-describedby={id}
          aria-label="More information"
          className="flex h-4 w-4 items-center justify-center rounded-full border border-ink-300 text-[10px] font-semibold text-ink-500 hover:bg-ink-100"
        >
          ?
        </button>
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-56 -translate-x-1/2 rounded-md bg-ink-900 px-2.5 py-1.5 text-xs font-normal text-white shadow-lg group-focus-within:block group-hover:block"
        >
          {text}
        </span>
      </span>
    </span>
  );
}

export function MoneyInput({
  value,
  onChange,
  currency,
  id,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  currency: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-ink-400">
        {currency}
      </span>
      <input
        id={id}
        inputMode="decimal"
        className="input pl-12 text-right tabular-nums"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => {
          const parsed = Number.parseFloat(event.target.value.replace(/,/g, ''));
          if (Number.isFinite(parsed)) onChange(parsed.toFixed(2));
        }}
        placeholder={placeholder ?? '0.00'}
        aria-label={`Amount in ${currency}`}
      />
    </div>
  );
}

export function AsyncSelect<T extends { id: string }>({
  path,
  label,
  value,
  onChange,
  render,
  placeholder,
  required,
}: {
  path: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  render: (item: T) => string;
  placeholder?: string;
  required?: boolean;
}): React.JSX.Element {
  const { data, loading } = useQuery<{ data: T[] }>(path);
  const id = useId();
  return (
    <Field label={label} htmlFor={id} required={required}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={loading}>
        <option value="">{loading ? 'Loading…' : (placeholder ?? 'Select…')}</option>
        {(data?.data ?? []).map((item) => (
          <option key={item.id} value={item.id}>
            {render(item)}
          </option>
        ))}
      </Select>
    </Field>
  );
}
