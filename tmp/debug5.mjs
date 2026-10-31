process.env.NODE_ENV='test';
process.env.JWT_SECRET='test-secret-test-secret-test-secret-1234';
process.env.ENCRYPTION_KEY='test-encryption-key-test-encryption-1';
const { createDb } = await import('../server/src/db/driver.ts');
const { dashboard } = await import('../server/src/domain/reports.ts');
const db = createDb('sqlite:data/ledgerline.db');
try {
  const d = await dashboard(db, 'fef57ad3-fbd8-4cee-8eab-612d2fd47887');
  console.log(JSON.stringify(d).slice(0,400));
} catch (e) { console.error('ERR', e); }
await db.close();
