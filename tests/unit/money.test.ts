import { describe, expect, it } from 'vitest';
import { applyRate, formatMoney, fromMinor, toMinor } from '../../server/src/lib/money.js';

describe('money helpers', () => {
  it('parses currency strings into minor units without float drift', () => {
    expect(toMinor('1,234.56')).toBe(123456);
    expect(toMinor('$0.10')).toBe(10);
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor('')).toBe(0);
    expect(toMinor('-12.345')).toBe(-1235);
  });

  it('round-trips minor units', () => {
    expect(fromMinor(123456)).toBe(1234.56);
    expect(fromMinor(0)).toBe(0);
  });

  it('computes basis point rates with rounding', () => {
    expect(applyRate(10000, 1500)).toBe(1500);
    expect(applyRate(999, 700)).toBe(70);
    expect(applyRate(100, 0)).toBe(0);
  });

  it('formats currency for a locale', () => {
    expect(formatMoney(123456, 'USD', 'en-US')).toBe('$1,234.56');
    expect(formatMoney(100000, 'GHS', 'en-GH')).toContain('1,000.00');
  });
});
