import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { postJournal, systemAccount } from '../domain/ledger.js';
import { SYSTEM_ACCOUNTS } from '../domain/accounts.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth, type AuthContext } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const itemSchema = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  itemType: z.enum(['inventory', 'service', 'non_inventory']).default('inventory'),
  salesPrice: z.coerce.number().int().min(0).default(0),
  purchaseCost: z.coerce.number().int().min(0).default(0),
  incomeAccountId: z.string().uuid().nullable().optional(),
  expenseAccountId: z.string().uuid().nullable().optional(),
  inventoryAssetAccountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
  quantityOnHand: z.coerce.number().min(0).optional(),
  reorderPoint: z.coerce.number().min(0).optional(),
});

async function assertInventoryEnabled(req: { ctx?: AuthContext }): Promise<void> {
  if (!req.ctx?.flags.inventory) {
    throw unprocessable('The inventory module is turned off for this company. Enable it in Settings → Features.');
  }
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/items', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(paginationSchema.extend({ type: z.string().optional(), lowStock: z.coerce.boolean().optional() }), req.query);
    const where = ['tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.type && query.type !== 'all') {
      where.push('item_type = ?');
      params.push(query.type);
    }
    if (query.lowStock) where.push('quantity_on_hand <= reorder_point AND item_type = \'inventory\'');
    if (query.q) {
      where.push('(LOWER(name) LIKE ? OR LOWER(sku) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all(
      `SELECT *, (quantity_on_hand * purchase_cost) AS stock_value FROM items WHERE ${where.join(' AND ')}
       ORDER BY name LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const summary = await req.db.get<{ count: number; value: number; low: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(quantity_on_hand * purchase_cost),0) AS value,
        COALESCE(SUM(CASE WHEN quantity_on_hand <= reorder_point THEN 1 ELSE 0 END),0) AS low
       FROM items WHERE tenant_id = ? AND item_type = 'inventory'`,
      [ctx.tenantId],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize, { summary });
  });

  app.post('/items', { preHandler: requireAuth('inventory:manage') }, async (req, reply) => {
    const body = parse(itemSchema, req.body);
    const ctx = req.ctx!;
    await assertInventoryEnabled(req);
    const clash = await req.db.get('SELECT id FROM items WHERE tenant_id = ? AND sku = ?', [ctx.tenantId, body.sku]);
    if (clash) throw conflict(`SKU ${body.sku} already exists`);
    const id = newId();
    const inventoryAsset = body.inventoryAssetAccountId ?? (await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.INVENTORY_ASSET)).id;
    await req.db.run(
      `INSERT INTO items (id, tenant_id, sku, name, description, item_type, sales_price, purchase_cost, income_account_id,
         expense_account_id, inventory_asset_account_id, tax_code_id, quantity_on_hand, reorder_point, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        ctx.tenantId,
        body.sku,
        body.name,
        body.description ?? null,
        body.itemType,
        body.salesPrice,
        body.purchaseCost,
        body.incomeAccountId ?? null,
        body.expenseAccountId ?? null,
        inventoryAsset,
        body.taxCodeId ?? null,
        body.quantityOnHand ?? 0,
        body.reorderPoint ?? 0,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'item.created',
      entityType: 'item',
      entityId: id,
      summary: `Created item ${body.sku}`,
      after: body,
    });
    return reply.code(201).send({ id });
  });

  app.get('/items/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const item = await req.db.get<Record<string, unknown>>('SELECT * FROM items WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!item) throw notFound('Item not found');
    const movements = await req.db.all('SELECT * FROM inventory_movements WHERE tenant_id = ? AND item_id = ? ORDER BY date DESC, created_at DESC LIMIT 100', [
      ctx.tenantId,
      id,
    ]);
    return { item, movements };
  });

  app.patch('/items/:id', { preHandler: requireAuth('inventory:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(itemSchema.partial(), req.body);
    const ctx = req.ctx!;
    const before = await req.db.get<Record<string, unknown>>('SELECT * FROM items WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!before) throw notFound('Item not found');
    await req.db.run(
      `UPDATE items SET sku = ?, name = ?, description = ?, item_type = ?, sales_price = ?, purchase_cost = ?,
        income_account_id = ?, expense_account_id = ?, tax_code_id = ?, reorder_point = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        body.sku ?? before.sku,
        body.name ?? before.name,
        body.description ?? before.description,
        body.itemType ?? before.item_type,
        body.salesPrice ?? before.sales_price,
        body.purchaseCost ?? before.purchase_cost,
        body.incomeAccountId ?? before.income_account_id,
        body.expenseAccountId ?? before.expense_account_id,
        body.taxCodeId ?? before.tax_code_id,
        body.reorderPoint ?? before.reorder_point,
        new Date().toISOString(),
        ctx.tenantId,
        id,
      ],
    );
    return { ok: true };
  });

  app.post('/items/:id/adjust', { preHandler: requireAuth('inventory:manage') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        quantity: z.coerce.number().refine((v) => v !== 0, 'Quantity change cannot be zero'),
        unitCost: z.coerce.number().int().min(0).optional(),
        reason: z.string().max(200).optional(),
        offsetAccountId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    await assertInventoryEnabled(req);
    const item = await req.db.get<{ id: string; name: string; purchase_cost: number; quantity_on_hand: number; sku: string }>(
      'SELECT * FROM items WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!item) throw notFound('Item not found');
    const newQty = Number(item.quantity_on_hand) + body.quantity;
    if (newQty < 0) throw unprocessable('Stock cannot go negative. Adjust purchases first.');
    const unitCost = body.unitCost ?? Number(item.purchase_cost);
    const totalCost = Math.round(Math.abs(body.quantity) * unitCost);
    const inventory = await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.INVENTORY_ASSET);
    const offset = body.offsetAccountId
      ? (await req.db.get<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, body.offsetAccountId]))?.id
      : (await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.INVENTORY_ADJUSTMENT)).id;
    if (!offset) throw unprocessable('Choose an adjustment account');

    const entryId = await postJournal(req.db, {
      tenantId: ctx.tenantId,
      date: body.date,
      memo: `Inventory adjustment — ${item.sku} ${item.name}`,
      sourceType: 'inventory',
      sourceId: id,
      currency: ctx.tenant.base_currency,
      createdBy: ctx.user.id,
      lines:
        body.quantity > 0
          ? [
              { accountId: inventory.id, debit: totalCost, description: 'Inventory increase' },
              { accountId: offset, credit: totalCost, description: 'Inventory adjustment' },
            ]
          : [
              { accountId: offset, debit: totalCost, description: 'Inventory adjustment' },
              { accountId: inventory.id, credit: totalCost, description: 'Inventory decrease' },
            ],
    });
    await req.db.run(
      `INSERT INTO inventory_movements (id, tenant_id, item_id, date, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, journal_entry_id, memo, created_at)
       VALUES (?, ?, ?, ?, 'adjustment', ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [newId(), ctx.tenantId, id, body.date, body.quantity, unitCost, totalCost, id, entryId, body.reason ?? null, new Date().toISOString()],
    );
    await req.db.run('UPDATE items SET quantity_on_hand = ?, updated_at = ? WHERE id = ?', [
      newQty,
      new Date().toISOString(),
      id,
    ]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'item.adjusted',
      entityType: 'item',
      entityId: id,
      summary: `Adjusted ${item.sku} by ${body.quantity}`,
      after: { quantity: body.quantity, journalEntryId: entryId },
    });
    return reply.code(201).send({ id: entryId, quantityOnHand: newQty });
  });

  app.get('/inventory/movements', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(paginationSchema.extend({ itemId: z.string().optional() }), req.query);
    const where = ['m.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.itemId) {
      where.push('m.item_id = ?');
      params.push(query.itemId);
    }
    const rows = await req.db.all(
      `SELECT m.*, i.sku, i.name AS item_name FROM inventory_movements m JOIN items i ON i.id = m.item_id
       WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.created_at DESC LIMIT 200`,
      params,
    );
    return { data: rows };
  });

  app.get('/inventory/valuation', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all<{ sku: string; name: string; quantity_on_hand: number; purchase_cost: number; value: number }>(
      `SELECT sku, name, quantity_on_hand, purchase_cost, (quantity_on_hand * purchase_cost) AS value
       FROM items WHERE tenant_id = ? AND item_type = 'inventory' ORDER BY name`,
      [ctx.tenantId],
    );
    const totalValue = rows.reduce((a, b) => a + Number(b.value), 0);
    return { rows, totalValue };
  });
}
