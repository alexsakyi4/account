import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./data/ledgerline.db');
const tenant = db.prepare("SELECT id FROM tenants WHERE slug='lakeside-trading'").get().id;
const sql = `SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
            SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit END) AS debit,
            SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit END) AS credit
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ?
     LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted' AND je.date >= ? AND je.date <= ?
     WHERE a.tenant_id = ? AND a.is_active = 1
     GROUP BY a.id, a.code, a.name, a.type, a.subtype
     ORDER BY a.code`;
try {
  const rows = db.prepare(sql).all(tenant, '2026-10-01', '2026-10-30', tenant);
  console.log('rows', rows.length, rows.slice(0,3));
} catch (e) { console.log('FAIL', e.message); }
