import { createDb } from '../server/src/db/driver.js';
import { dashboard, profitAndLoss, aging, balanceSheet } from '../server/src/domain/reports.js';
const db = createDb();
const tenant = (await db.get<{id:string}>("SELECT id FROM tenants WHERE slug='lakeside-trading'"))!;
const steps: Array<[string, () => Promise<unknown>]> = [
  ['pnl', () => profitAndLoss(db, tenant.id, '2026-10-01', '2026-10-30')],
  ['bs', () => balanceSheet(db, tenant.id, '2026-10-30')],
  ['ar', () => aging(db, tenant.id, '2026-10-30', 'receivable')],
  ['dash', () => dashboard(db, tenant.id, '2026-10-30')],
];
for (const [name, fn] of steps) {
  try { await fn(); console.log(name, 'ok'); } catch (e) { console.log(name, 'FAIL', (e as Error).message); }
}
await db.close();
