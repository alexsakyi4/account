// TEMPORARY diagnostic endpoint — deleted once the deployment is verified.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export default async function handler(_req, res) {
  const cwd = process.cwd();
  const taskRoot = existsSync('/var/task') ? '/var/task' : cwd;
  const out = { ok: true, cwd, taskRoot };

  const nm = path.join(taskRoot, 'node_modules');
  out.hasNodeModules = existsSync(nm);
  if (out.hasNodeModules) {
    const dirs = readdirSync(nm);
    out.nodeModuleCount = dirs.filter((d) => !d.startsWith('.')).length;
    out.keyPackages = ['fastify', 'pg', '@fastify', 'pdfkit', 'dotenv', 'zod'].filter(
      (d) => existsSync(path.join(nm, d)),
    );
  }

  out.entryExists = existsSync(path.join(taskRoot, 'api/index.js'));
  try {
    const mod = await import('./index.js');
    out.handlerType = typeof mod.default;
  } catch (err) {
    out.importError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (err instanceof Error && err.stack) out.importStack = err.stack.split('\n').slice(0, 10).join('\n');
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}
