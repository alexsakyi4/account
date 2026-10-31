/**
 * Simplified progressive payroll tax engine.
 *
 * Rates are configuration, not law: replace `BRACKETS` with a jurisdiction
 * module to localise. All arithmetic is in minor units and deterministic, so the
 * function is trivially unit-testable.
 */
export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'annual';

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

export interface TaxBracket {
  upTo: number; // annual minor units; Infinity for the top bracket
  rateBp: number;
}

export const INCOME_TAX_BRACKETS: TaxBracket[] = [
  { upTo: 1_200_000, rateBp: 0 },
  { upTo: 4_500_000, rateBp: 1200 },
  { upTo: 10_000_000, rateBp: 2200 },
  { upTo: Number.POSITIVE_INFINITY, rateBp: 3000 },
];

export const SOCIAL_SECURITY = { rateBp: 620, wageBase: 16_000_000 };
export const MEDICARE = { rateBp: 145 };

export interface PayrollResult {
  gross: number;
  incomeTax: number;
  socialTax: number;
  medicare: number;
  employerSocial: number;
  employerMedicare: number;
  net: number;
  employerCost: number;
}

export function computePayrollLine(gross: number, frequency: PayFrequency = 'monthly'): PayrollResult {
  const periods = PERIODS_PER_YEAR[frequency] ?? 12;
  const annualGross = Math.round(gross * periods);
  let remaining = annualGross;
  let previous = 0;
  let annualTax = 0;
  for (const bracket of INCOME_TAX_BRACKETS) {
    if (remaining <= 0) break;
    const slice = Math.min(remaining, bracket.upTo - previous);
    annualTax += Math.round((slice * bracket.rateBp) / 10_000);
    remaining -= slice;
    previous = bracket.upTo;
  }
  const incomeTax = Math.round(annualTax / periods);
  const ssBase = Math.min(annualGross, SOCIAL_SECURITY.wageBase);
  const socialTax = Math.round((ssBase * SOCIAL_SECURITY.rateBp) / 10_000 / periods);
  const medicare = Math.round((annualGross * MEDICARE.rateBp) / 10_000 / periods);
  const employerSocial = Math.round((ssBase * SOCIAL_SECURITY.rateBp) / 10_000 / periods);
  const employerMedicare = Math.round((annualGross * MEDICARE.rateBp) / 10_000 / periods);
  const net = gross - incomeTax - socialTax - medicare;
  return {
    gross,
    incomeTax,
    socialTax,
    medicare,
    employerSocial,
    employerMedicare,
    net,
    employerCost: gross + employerSocial + employerMedicare,
  };
}

export function periodPay(grossAnnual: number, frequency: PayFrequency = 'monthly'): number {
  return Math.round(grossAnnual / (PERIODS_PER_YEAR[frequency] ?? 12));
}
