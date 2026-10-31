/**
 * Money is handled as integer minor units everywhere (cents, pence, pesewas).
 * Conversion is deliberately explicit: DB -> bigint, API -> number, UI -> string.
 */
export { toMinor, fromMinor, minorToInput, formatMoney } from '../../../shared/money.js';

/** Basis points (1/100 of a percent) applied to a minor-unit amount. */
export function applyRate(minor: number, rateBp: number): number {
  return Math.round((minor * rateBp) / 10_000);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
