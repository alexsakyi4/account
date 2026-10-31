import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../modules/auth.js';
import { accountRoutes } from '../modules/accounts.js';
import { contactRoutes } from '../modules/contacts.js';
import { salesRoutes } from '../modules/sales.js';
import { purchaseRoutes } from '../modules/purchases.js';
import { paymentRoutes } from '../modules/payments.js';
import { bankingRoutes } from '../modules/banking.js';
import { journalRoutes } from '../modules/journal.js';
import { reportRoutes } from '../modules/reports.js';
import { inventoryRoutes } from '../modules/inventory.js';
import { payrollRoutes } from '../modules/payroll.js';
import { settingsRoutes } from '../modules/settings.js';
import { importRoutes } from '../modules/imports.js';
import { integrationRoutes } from '../modules/integrations.js';
import { adminRoutes } from '../modules/admin.js';

/** Route table for /api/v1. Modules stay independent so features can be
 *  mounted, versioned or extracted into services without cross-imports. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(contactRoutes);
  await app.register(salesRoutes);
  await app.register(purchaseRoutes);
  await app.register(paymentRoutes);
  await app.register(bankingRoutes);
  await app.register(journalRoutes);
  await app.register(reportRoutes);
  await app.register(inventoryRoutes);
  await app.register(payrollRoutes);
  await app.register(settingsRoutes);
  await app.register(importRoutes);
  await app.register(integrationRoutes);
  await app.register(adminRoutes);
}
