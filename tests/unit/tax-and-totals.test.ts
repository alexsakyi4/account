import { describe, expect, it } from 'vitest';
import { applyRate } from '../../server/src/lib/money.js';
import { computePayrollLine } from '../../server/src/domain/payroll.js';
import { chartTemplate, normalBalanceFor, SYSTEM_ACCOUNTS } from '../../server/src/domain/accounts.js';

describe('tax and payroll calculations', () => {
  it('applies exclusive VAT', () => {
    const net = 100_000;
    expect(applyRate(net, 1500)).toBe(15_000);
  });

  it('backs VAT out of inclusive prices', () => {
    const gross = 115_000;
    const rateBp = 1500;
    const base = Math.round((gross * 10_000) / (10_000 + rateBp));
    expect(base).toBe(100_000);
    expect(gross - base).toBe(15_000);
  });

  it('computes progressive payroll tax and net pay', () => {
    const result = computePayrollLine(500_000, 'monthly'); // $5,000/month = $60k/year
    expect(result.gross).toBe(500_000);
    expect(result.net).toBeLessThan(result.gross);
    expect(result.incomeTax).toBeGreaterThan(0);
    expect(result.socialTax).toBeGreaterThan(0);
    expect(result.employerCost).toBeGreaterThan(result.gross);
    expect(result.gross - result.incomeTax - result.socialTax - result.medicare).toBe(result.net);
  });

  it('does not tax income below the threshold', () => {
    const result = computePayrollLine(50_000, 'monthly'); // $6000/yr
    expect(result.incomeTax).toBe(0);
  });
});

describe('chart of accounts template', () => {
  it('includes every system account used by automation', () => {
    const template = chartTemplate('general');
    const keys = new Set(template.map((a) => a.systemKey).filter(Boolean));
    for (const key of Object.values(SYSTEM_ACCOUNTS)) {
      expect(keys.has(key), `missing system account ${key}`).toBe(true);
    }
  });

  it('assigns the accounting normal balance per type', () => {
    expect(normalBalanceFor('asset')).toBe('debit');
    expect(normalBalanceFor('expense')).toBe('debit');
    expect(normalBalanceFor('liability')).toBe('credit');
    expect(normalBalanceFor('equity')).toBe('credit');
    expect(normalBalanceFor('income')).toBe('credit');
  });

  it('produces unique account codes per industry', () => {
    for (const industry of ['general', 'retail', 'services', 'construction', 'restaurant', 'nonprofit', 'technology']) {
      const codes = new Set(chartTemplate(industry).map((a) => a.code));
      expect(codes.size, `duplicate codes in ${industry}`).toBe(chartTemplate(industry).length);
    }
  });
});
