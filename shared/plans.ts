/** Subscription plans — one definition used by billing, seat checks and the platform console. */
export const PLANS = [
  {
    code: 'trial',
    name: 'Trial',
    priceCents: 0,
    seats: 5,
    features: ['All core modules', 'Sample company', 'Community support'],
  },
  {
    code: 'starter',
    name: 'Starter',
    priceCents: 1900,
    seats: 5,
    features: ['Invoicing & bills', 'Bank reconciliation', 'Reports'],
  },
  {
    code: 'growth',
    name: 'Growth',
    priceCents: 4900,
    seats: 15,
    features: ['Everything in Starter', 'Payroll', 'Inventory', 'API access'],
  },
  {
    code: 'firm',
    name: 'Accounting firm',
    priceCents: 12900,
    seats: 100,
    features: ['Multi-company', 'Audit exports', 'SSO', 'Priority support'],
  },
] as const;

export type PlanCode = (typeof PLANS)[number]['code'];
export const PLAN_CODES = PLANS.map((plan) => plan.code) as [PlanCode, ...PlanCode[]];

export function planFor(code: string) {
  return PLANS.find((plan) => plan.code === code) ?? PLANS[0];
}

/** Seats allowed for a plan code; unknown plans fall back to the trial allowance. */
export function seatLimit(code: string): number {
  return planFor(code).seats;
}
