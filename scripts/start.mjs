#!/usr/bin/env node
/**
 * `pnpm start` — spec §8.1 fork-and-run: one command runs the whole agent.
 * Spawns the worker (watcher, metabolism, commit, outcomes, deep-dive,
 * benchmark-snapshot loops) and the API side by side, forwards both to this
 * process's stdio, and brings both down together on Ctrl-C or if either one
 * exits. No new dependency (`concurrently` etc.) — just node's own
 * `child_process`, since this is the one thing every fork needs to work with
 * zero `pnpm install` surprises.
 */
import { spawn } from 'node:child_process';

const procs = [
  { name: 'worker', cmd: 'pnpm', args: ['--filter', '@launch-auditor/worker', 'start'] },
  { name: 'api', cmd: 'pnpm', args: ['--filter', '@launch-auditor/api', 'start'] },
  { name: 'web', cmd: 'pnpm', args: ['--filter', '@launch-auditor/web', 'start'] },
].map(({ name, cmd, args }) => {
  const p = spawn(cmd, args, { stdio: 'pipe', shell: process.platform === 'win32' });
  const prefix = `[${name}] `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}exited (${code}) — stopping the other process`);
    shutdown(code ?? 1);
  });
  return p;
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
