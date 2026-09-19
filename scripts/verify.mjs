// Single verification entrypoint for every milestone.
// Runs offline: no Docker, no network, no paid APIs.
import { execSync } from 'node:child_process';

// `prisma validate` resolves env("DATABASE_URL") eagerly. Give it a placeholder
// so verify works on a fresh checkout with no .env. Nothing here connects.
process.env.DATABASE_URL ??=
  'postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public';

const SCHEMA = 'packages/db/prisma/schema.prisma';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

// prisma generate rewrites a native engine .dll/.node; on Windows that fails
// with EPERM/EBUSY while another process (e.g. `pnpm dev:worker`) has it loaded.
// The schema is still validated below, so treat a lock as a skip, not a failure.
const LOCK = /EPERM|EBUSY|EACCES|operation not permitted|resource busy|used by another process/i;
function generate() {
  try {
    execSync(`pnpm exec prisma generate --schema ${SCHEMA}`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    process.stdout.write(out);
    if (LOCK.test(out)) {
      process.stdout.write(
        '\n⚠ prisma generate skipped — engine file locked by a running process ' +
          '(stop `pnpm dev:worker` / node to regenerate). Using the existing client.\n',
      );
      return;
    }
    throw err;
  }
}

function forgeTests() {
  try {
    execSync('forge --version', { stdio: 'ignore' });
  } catch {
    process.stdout.write('⚠ forge not on PATH — skipping contract tests (install Foundry to run them)\n');
    return;
  }
  run('forge test --root packages/contracts');
}

const steps = [
  ['Prisma client generate', generate],
  ['Prisma schema validate', () => run(`pnpm exec prisma validate --schema ${SCHEMA}`)],
  ['Typecheck (all packages)', () => run('pnpm -r --workspace-concurrency=1 typecheck')],
  ['Tests (vitest)', () => run('pnpm -r --workspace-concurrency=1 test')],
  ['Contract tests (forge)', forgeTests],
];

let failed = null;
for (const [name, step] of steps) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    step();
  } catch {
    failed = name;
    break;
  }
}

process.stdout.write('\n' + '─'.repeat(60) + '\n');
if (failed) {
  process.stdout.write(`❌ verify failed at: ${failed}\n`);
  process.exit(1);
}
process.stdout.write('✅ verify passed — prisma schema + typecheck + tests all green\n');
