import { describe, expect, it } from 'vitest';
import { parseReceiptText } from '../../server/src/services/ocr.js';
import { ruleMatches } from '../../server/src/modules/banking.js';
import { nextDate } from '../../server/src/jobs/worker.js';

describe('receipt OCR parsing', () => {
  it('extracts vendor, date, subtotal, tax and total', () => {
    const fields = parseReceiptText(`Office Depot Ltd
Receipt
Date: 2024-05-12
Subtotal: 120.00
Tax: 18.00
TOTAL: $138.00`);
    expect(fields.vendor).toBe('Office Depot Ltd');
    expect(fields.date).toBe('2024-05-12');
    expect(fields.subtotal).toBe(12000);
    expect(fields.tax).toBe(1800);
    expect(fields.total).toBe(13800);
    expect(fields.currency).toBe('USD');
  });

  it('normalises US style dates and local currency symbols', () => {
    const fields = parseReceiptText('Big Shop\n05/09/2024\nTotal: ₵250.50');
    expect(fields.date).toBe('2024-05-09');
    expect(fields.currency).toBe('GHS');
    expect(fields.total).toBe(25050);
  });
});

describe('bank matching rules', () => {
  const txn = { amount: -4500, description: 'AWS EMEA SARL', payee: 'Amazon Web Services' };

  it('matches description substrings', () => {
    expect(
      ruleMatches({ match_field: 'description', match_op: 'contains', match_value: 'aws', tx_direction: 'any', amount_min: null, amount_max: null }, txn),
    ).toBe(true);
  });

  it('respects direction filters', () => {
    expect(
      ruleMatches({ match_field: 'description', match_op: 'contains', match_value: 'aws', tx_direction: 'credit', amount_min: null, amount_max: null }, txn),
    ).toBe(false);
  });

  it('applies amount bounds to absolute amounts', () => {
    expect(
      ruleMatches({ match_field: 'payee', match_op: 'starts_with', match_value: 'amazon', tx_direction: 'debit', amount_min: 4000, amount_max: 5000 }, txn),
    ).toBe(true);
    expect(
      ruleMatches({ match_field: 'payee', match_op: 'starts_with', match_value: 'amazon', tx_direction: 'debit', amount_min: 6000, amount_max: 9000 }, txn),
    ).toBe(false);
  });
});

describe('recurring schedules', () => {
  it('advances monthly, quarterly, yearly and weekly', () => {
    expect(nextDate('2024-01-31', 'monthly')).toBe('2024-03-02');
    expect(nextDate('2024-01-15', 'quarterly')).toBe('2024-04-15');
    expect(nextDate('2024-01-15', 'yearly')).toBe('2025-01-15');
    expect(nextDate('2024-01-15', 'weekly')).toBe('2024-01-22');
    expect(nextDate('2024-01-15', 'monthly', 2)).toBe('2024-03-15');
  });
});
