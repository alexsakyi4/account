/**
 * Vercel build: compile the SPA, inline the SQL migrations and bundle the API
 * into a single serverless function (api/index.js).
 *
 *   node scripts/build-vercel.mjs                  # SPA + function
 *   node scripts/build-vercel.mjs --functions-only # migrations + function only
 */
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

console.log('▸ inlining migrations');
execFileSync(process.execPath, ['scripts/bundle-migrations.mjs'], { stdio: 'inherit' });

const functionsOnly = process.argv.includes('--functions-only');
if (!functionsOnly) {
  console.log('▸ building web');
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
}

console.log('▸ bundling api/index.js');
await build({
  entryPoints: ['serverless/entry.ts'],
  outfile: 'api/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: true,
  // Dependencies stay external: Vercel installs them from package.json, which also
  // keeps PDFKit's bundled font metrics working at runtime.
  packages: 'external',
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
console.log('✓ api/index.js ready');
