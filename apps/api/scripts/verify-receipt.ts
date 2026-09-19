/**
 * pnpm verify:receipt <reportHash> [--api URL] [--rpc URL] [--signer 0x…] [--registry 0x…] [--file receipt.json]
 *
 * Checks one forecast without a database or any operator credential:
 *   canonical bytes → keccak256 → reportHash
 *   canonical content → EIP-712 → recovered signer == the published agent signer
 *   reportHash + proof → Merkle root
 *   root ∈ BatchCommitted event in that block (any RPC) → the block's own timestamp
 *   → each outcome's eligibility, recomputed from that timestamp.
 * The API (or --file) is only a place to fetch bytes from; every conclusion is recomputed here.
 */
import { readFileSync } from 'node:fs';
import type { Receipt } from '../src/receipt';
import { eligibilityFromChain, verifyReceiptOffline, verifyReceiptOnChain } from '../src/verify-receipt';

const DEFAULTS = {
  api: 'https://api-production-6a84.up.railway.app',
  rpc: 'https://rpc.ordofi.network', // public, keyless; any chain-4663 RPC works
  signer: '0x6a5A2d5Ad4c4De33f851f971fa14923f5095B4BE', // published report signer (README / DEMO.md)
  registry: '0xF36F84a7B7DfFB952341d021db51bD76E54fDBEe', // CommitRegistry, deployments/4663.json
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const hash = process.argv.slice(2).find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
  if (!hash) {
    console.error('usage: pnpm verify:receipt <reportHash> [--api URL] [--rpc URL] [--signer 0x…] [--registry 0x…] [--file receipt.json]');
    process.exit(2);
  }
  const file = arg('file');
  const receipt: Receipt = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : await (await fetch(`${(arg('api') ?? DEFAULTS.api).replace(/\/$/, '')}/v1/receipt/${hash}`)).json();

  const offline = await verifyReceiptOffline(receipt, hash, arg('signer') ?? DEFAULTS.signer);
  const onChain = await verifyReceiptOnChain(receipt, arg('rpc') ?? DEFAULTS.rpc, arg('registry') ?? DEFAULTS.registry);
  const checks = [...offline, ...onChain.checks];
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(14)} ${c.detail}`);

  const content = JSON.parse(receipt.canonicalJson) as { tokenAddress?: string; reportTime?: string; forecaster?: string; probabilities?: Record<string, number> };
  console.log(`\nforecast  ${content.forecaster} on ${content.tokenAddress}, anchored ${content.reportTime}`);
  if (onChain.blockTime && content.reportTime) {
    const lag = Math.round((onChain.blockTime.getTime() - Date.parse(content.reportTime)) / 1000);
    console.log(`committed ${onChain.blockTime.toISOString()} (${lag}s after the anchor)`);
  }
  const elig = new Map(eligibilityFromChain(receipt, onChain.blockTime).map((e) => [e.outcome, e.eligibility]));
  console.log('\noutcome              forecast   result      eligibility (from chain time)');
  for (const o of receipt.outcomes) {
    const key = `${o.label}@${o.horizon}`;
    const p = content.probabilities?.[key];
    const result = o.status === 'RESOLVED' ? String(o.value) : o.status.toLowerCase();
    console.log(`${key.padEnd(20)} ${(p == null ? '—' : p.toFixed(4)).padEnd(10)} ${result.padEnd(11)} ${elig.get(key)}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
