/** Runs the API and the Vite dev server together with colour-coded output. */
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', colour: '\x1b[36m', cmd: 'npx', args: ['tsx', 'watch', 'server/src/index.ts'] },
  { name: 'web', colour: '\x1b[35m', cmd: 'npx', args: ['vite'] },
];

const children = procs.map(({ name, colour, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `${colour}[${name}]\x1b[0m `;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) target.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}exited with ${code}`));
  return child;
});

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
