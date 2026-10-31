import { describe, expect, it } from 'vitest';
import { can, permissionsFor, ROLE_LABELS, ROLE_PERMISSIONS, ROLES } from '../../shared/roles.js';
import { decimalsFor, formatMoney, fromMinor, minorToInput, toMinor } from '../../shared/money.js';

describe('shared role catalogue', () => {
  it('gives admins every permission and employees only self-service', () => {
    expect(ROLES).toHaveLength(4);
    expect(permissionsFor('admin')).toHaveLength(19);
    expect(permissionsFor('employee').sort()).toEqual(['expenses:submit', 'timesheets:submit']);
  });

  it('keeps bookkeepers out of company administration', () => {
    expect(can('bookkeeper', 'invoices:write')).toBe(true);
    expect(can('bookkeeper', 'company:manage')).toBe(false);
    expect(can('bookkeeper', 'billing:manage')).toBe(false);
    expect(can('nonsense', 'reports:read')).toBe(false);
  });

  it('labels every role and never grants an unknown permission', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      for (const permission of ROLE_PERMISSIONS[role]) expect(permissionsFor(role)).toContain(permission);
    }
  });
});

describe('shared money helpers', () => {
  it('rounds half away from zero, including negatives', () => {
    expect(toMinor('10.005')).toBe(1001);
    expect(toMinor(-10.005)).toBe(-1001);
    expect(toMinor('1,250.00')).toBe(125000);
    expect(toMinor('')).toBe(0);
    expect(toMinor('abc')).toBe(0);
  });

  it('round-trips minor units to input strings', () => {
    expect(minorToInput(125000)).toBe('1250.00');
    expect(fromMinor('125000')).toBe(1250);
    expect(formatMoney(125000, 'USD')).toBe('$1,250.00');
    expect(decimalsFor('JPY')).toBe(0);
    expect(decimalsFor('ghs')).toBe(2);
  });
});
