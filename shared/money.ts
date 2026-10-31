/**
 * Money is handled as integer minor units everywhere (cents, pence, pesewas).
 * Conversion is explicit at every boundary: DB -> bigint, API -> number,
 * UI -> decimal string.
 */

/** Round half away from zero, unlike Math.round which rounds -0.5 to -0. */
function roundAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function toMinor(amount: number | string | null | undefined, decimals = 2): number {
  if (amount === null || amount === undefined || amount === '') return 0;
  const factor = 10 ** decimals;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return 0;
    return roundAwayFromZero(amount * factor);
  }
  const cleaned = String(amount).replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return roundAwayFromZero(parsed * factor);
}

export function fromMinor(minor: number | string | null | undefined, decimals = 2): number {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 10 ** decimals).toFixed(decimals));
}

/** Plain decimal string for <input> fields: 123456 -> "1234.56". */
export function minorToInput(minor: number | null | undefined, decimals = 2): string {
  return fromMinor(minor, decimals).toFixed(decimals);
}

const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(minor: number, currency = 'USD', locale = 'en-US'): string {
  const key = `${locale}:${currency}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 });
    formatters.set(key, fmt);
  }
  return fmt.format(fromMinor(minor));
}

export const ZERO_DECIMAL_CURRENCIES = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF'] as const;

/** Currencies whose smallest unit is the whole unit, not 1/100. */
export function decimalsFor(currency: string): number {
  return (ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(currency.toUpperCase()) ? 0 : 2;
}
