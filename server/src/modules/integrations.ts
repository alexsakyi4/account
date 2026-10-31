import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { newId } from '../db/driver.js';
import { randomToken } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { WEBHOOK_EVENTS, deliverPending, publicApiBase } from '../services/events.js';

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/webhooks', { preHandler: requireAuth('integrations:manage') }, async (req) => ({
    data: await req.db.all(
      `SELECT w.id, w.url, w.events, w.is_active, w.created_at,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed
       FROM webhooks w WHERE w.tenant_id = ? ORDER BY w.created_at DESC`,
      [req.ctx!.tenantId],
    ),
    events: WEBHOOK_EVENTS,
  }));

  app.post('/webhooks', { preHandler: requireAuth('integrations:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        url: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://10.') || process.env.NODE_ENV !== 'production', {
          message: 'Webhook URLs must use HTTPS in production',
        }),
        events: z.array(z.string()).min(1),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const id = newId();
    const secret = `whsec_${randomToken(24)}`;
    await req.db.run(
      `INSERT INTO webhooks (id, tenant_id, url, secret, events, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, ctx.tenantId, body.url, secret, body.events.join(','), new Date().toISOString()],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'webhook.created',
      entityType: 'webhook',
      entityId: id,
      summary: `Webhook registered for ${body.events.length} events`,
    });
    return reply.code(201).send({ id, secret, note: 'Use this secret to verify the x-ledgerline-signature header.' });
  });

  app.delete('/webhooks/:id', { preHandler: requireAuth('integrations:manage') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await req.db.run('DELETE FROM webhooks WHERE tenant_id = ? AND id = ?', [req.ctx!.tenantId, id]);
    return reply.code(204).send();
  });

  app.post('/webhooks/test', { preHandler: requireAuth('integrations:manage') }, async (req) => {
    const ctx = req.ctx!;
    const hooks = await req.db.all<{ id: string; url: string }>('SELECT id, url FROM webhooks WHERE tenant_id = ? AND is_active = 1', [ctx.tenantId]);
    for (const hook of hooks) {
      await req.db.run(
        `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'ping', ?, 'pending', 0, ?, ?)`,
        [newId(), ctx.tenantId, hook.id, JSON.stringify({ event: 'ping', data: { message: 'LedgerLine webhook test' } }), new Date().toISOString(), new Date().toISOString()],
      );
    }
    await deliverPending(req.db);
    return { queued: hooks.length };
  });

  app.get('/webhooks/deliveries', { preHandler: requireAuth('integrations:manage') }, async (req) => ({
    data: await req.db.all('SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100', [req.ctx!.tenantId]),
  }));

  app.get('/integrations', { preHandler: requireAuth() }, async () => ({
    payments: { provider: config.stripeSecretKey ? 'stripe' : 'sandbox', configured: Boolean(config.stripeSecretKey) },
    bankFeeds: { provider: config.plaidClientId ? 'plaid' : 'csv', configured: Boolean(config.plaidClientId) },
    ocr: { provider: config.ocrProvider, configured: config.ocrProvider === 'http' ? Boolean(process.env.OCR_ENDPOINT) : true },
    email: { transport: config.smtpUrl ? 'relay' : config.isProd ? 'unconfigured' : 'capture' },
    api: { baseUrl: publicApiBase(), version: 'v1', auth: ['Bearer JWT', 'X-API-Key'] },
  }));

  // ------------------------------------------------------------- API docs --
  app.get('/openapi.json', async (_req, reply) => {
    const candidates = [path.resolve(process.cwd(), 'docs/openapi.json'), path.resolve(process.cwd(), '../../docs/openapi.json')];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, 'utf8');
        return reply.header('content-type', 'application/json').send(raw);
      } catch {
        /* try the next location */
      }
    }
    throw notFound('OpenAPI document is not bundled with this build');
  });

  app.get('/docs', async (_req, reply) => {
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>LedgerLine API reference</title>
<style>
 :root{color-scheme:light;--ink:#0f172a;--muted:#64748b;--brand:#0f766e;--line:#e2e8f0}
 body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;background:#f8fafc}
 header{background:#fff;border-bottom:1px solid var(--line);padding:24px 32px}
 h1{margin:0 0 4px;font-size:22px} p{margin:0;color:var(--muted)}
 main{padding:24px 32px;max-width:1100px;margin:0 auto}
 .row{display:flex;gap:12px;align-items:center;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
 .method{font:600 11px ui-monospace,monospace;padding:3px 8px;border-radius:6px;color:#fff;min-width:58px;text-align:center}
 .get{background:#0ea5e9}.post{background:#16a34a}.patch{background:#f59e0b}.delete{background:#ef4444}.put{background:#8b5cf6}
 code{font:13px ui-monospace,monospace}
 .summary{color:var(--muted);font-size:13px;margin-left:auto}
 input{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font:13px ui-monospace,monospace;margin:8px 0 18px}
</style></head>
<body><header><h1>LedgerLine REST API v1</h1><p>OpenAPI 3.1 specification · <a href="/api/v1/openapi.json">openapi.json</a> · Base URL <code>/api/v1</code></p></header>
<main><label for="token"><strong>Bearer token</strong> (stored in this tab only)</label>
<input id="token" placeholder="Paste an access token or API key (ll_...)" />
<div id="list">Loading specification…</div></main>
<script>
const token=document.getElementById('token');
token.value=sessionStorage.getItem('ll_token')||'';
token.addEventListener('input',()=>sessionStorage.setItem('ll_token',token.value));
fetch('/api/v1/openapi.json').then(r=>r.json()).then(spec=>{
  const list=document.getElementById('list');list.innerHTML='';
  const groups={};
  Object.entries(spec.paths||{}).forEach(([p,methods])=>Object.entries(methods).forEach(([m,op])=>{
    const tag=(op.tags&&op.tags[0])||'Other';(groups[tag]=groups[tag]||[]).push({p,m,op});
  }));
  Object.entries(groups).forEach(([tag,items])=>{
    const h=document.createElement('h3');h.textContent=tag;list.appendChild(h);
    items.forEach(({p,m,op})=>{
      const row=document.createElement('div');row.className='row';
      const method=document.createElement('span');method.className='method '+m;method.textContent=m.toUpperCase();
      const path=document.createElement('code');path.textContent=p;
      const summary=document.createElement('span');summary.className='summary';summary.textContent=op.summary||'';
      row.append(method,path,summary);list.appendChild(row);
    });
  });
}).catch(()=>{document.getElementById('list').textContent='Could not load the specification.'});
</script></body></html>`);
  });
}
