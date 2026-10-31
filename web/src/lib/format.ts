/** Formatting helpers. Money is stored in minor units (cents) end to end. */

export function formatMoney(amountMinor: number | null | undefined, currency = 'USD', options: { compact?: boolean; sign?: boolean } = {}): string {
  const value = (amountMinor ?? 0) / 100;
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: options.compact && Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: options.compact && Math.abs(value) >= 10_000 ? 1 : 2,
    minimumFractionDigits: options.compact && Math.abs(value) >= 10_000 ? 0 : 2,
    signDisplay: options.sign ? 'exceptZero' : 'auto',
  });
  return formatter.format(value);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value ?? 0);
}

import { minorToInput } from '../../../shared/money';

export { toMinor } from '../../../shared/money';

/** Minor units → plain decimal string for <input> fields. */
export function fromMinor(amountMinor: number | null | undefined): string {
  return minorToInput(amountMinor);
}

export function formatDate(value: string | null | undefined, style: 'short' | 'medium' | 'long' = 'medium'): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions =
    style === 'short'
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : style === 'long'
        ? { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', opts).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function startOfYear(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

export function startOfMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function daysOverdue(dueDate: string | null | undefined): number {
  if (!dueDate) return 0;
  const diff = Date.now() - new Date(`${dueDate}T00:00:00Z`).getTime();
  return diff > 0 ? Math.floor(diff / 86_400_000) : 0;
}

export function percentFromBasisPoints(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
