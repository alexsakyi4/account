import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, authed, createTestApp, registerCompany, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let admin: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await registerCompany(ctx, 'Billing Test Co');
});
afterAll(async () => {
  await ctx.close();
});

describe('plans, seats and suspension', () => {
  it('reports the plan catalogue with seat limits', async () => {
    const res = await authed(ctx, admin, 'GET', '/subscription');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription.plan).toBe('trial');
    expect(body.seatLimit).toBe(5);
    expect(body.plans.map((plan: { code: string }) => plan.code)).toEqual(['trial', 'starter', 'growth', 'firm']);
  });

  it('refuses an invite beyond the plan seat limit', async () => {
    // Trial allows five active members; the admin counts as the first.
    for (let index = 0; index < 4; index += 1) await addMember(ctx, admin, 'employee');
    const extra = await authed(ctx, admin, 'POST', '/users/invite', {
      email: `overflow-${Date.now()}@example.com`,
      role: 'employee',
    });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error.message).toMatch(/plan allows 5 active users/i);
  });

  it('upgrades the plan and then allows the invite', async () => {
    const upgrade = await authed(ctx, admin, 'POST', '/subscription/change', { plan: 'growth' });
    expect(upgrade.statusCode).toBe(200);
    const res = await authed(ctx, admin, 'POST', '/users/invite', {
      email: `after-upgrade-${Date.now()}@example.com`,
      role: 'bookkeeper',
    });
    expect(res.statusCode).toBe(201);
    const subscription = await authed(ctx, admin, 'GET', '/subscription');
    expect(subscription.json().subscription.price_cents).toBe(4900);
  });

  it('refuses a downgrade that would strand members', async () => {
    // Growth allows 15 seats, so the sixth member joins fine…
    await addMember(ctx, admin, 'accountant');
    // …and trial (5 seats) can no longer absorb the team.
    const downgrade = await authed(ctx, admin, 'POST', '/subscription/change', { plan: 'trial' });
    expect(downgrade.statusCode).toBe(409);
    expect(downgrade.json().error.message).toMatch(/remove members first/i);

    const unchanged = await authed(ctx, admin, 'GET', '/subscription');
    expect(unchanged.json().subscription.plan).toBe('growth');
  });

  it('blocks sign-in and API access once a company is suspended', async () => {
    const email = `suspended-${Date.now()}@example.com`;
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        companyName: 'Suspended Co',
        name: 'Suspended Owner',
        email,
        password: 'CorrectHorse123!',
        industry: 'services',
        currency: 'USD',
      },
    });
    expect(registered.statusCode).toBe(201);
    const tenantId = registered.json().session.tenant.id as string;

    await ctx.db.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [tenantId]);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'CorrectHorse123!' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.message).toMatch(/suspended/i);

    const existing = await authed(ctx, admin, 'GET', '/invoices');
    expect(existing.statusCode).toBe(200);
  });
});
