import { concatHex, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { REPORT_COMMITMENT_TYPES, buildReceipt, type Receipt, type ReceiptRow } from '../src/receipt';
import { buildServer } from '../src/server';
import { eligibilityFromChain, rootInTxLogs, verifyReceiptOffline } from '../src/verify-receipt';

const TOKEN = '0xafb2e8581cc8e7c125163d1efe0061d8632ee458';
const ANCHOR = new Date('2026-09-18T13:47:34Z'); // the audit's outage replay
const OUTCOMES = ['1h', '6h', '24h'].map((h) => ({ label: 'SELL_IMPAIRED', horizon: h, status: 'PENDING', value: null }));

const sortedPair = (a: Hex, b: Hex): Hex => (a.toLowerCase() <= b.toLowerCase() ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a])));

/** A genuinely signed report in a two-leaf batch, signed by a throwaway key. */
async function signedFixture(): Promise<{ row: ReceiptRow; signer: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const content = {
    version: 'report/v0',
    chainId: 4663,
    tokenAddress: TOKEN,
    reportTime: ANCHOR.toISOString(),
    trigger: 'launch',
    forecaster: 'det_v0',
    probabilities: { 'INSIDER_EXIT@24h': 0.9972 },
  };
  const cj = JSON.stringify(content); // the verifier hashes whatever bytes it is given
  const hash = keccak256(stringToHex(cj));
  const signature = await account.signTypedData({
    domain: { name: 'LaunchAuditor', version: '1', chainId: 4663 },
    types: REPORT_COMMITMENT_TYPES,
    primaryType: 'ReportCommitment',
    message: { reportHash: hash, chainId: 4663n, token: TOKEN, reportTime: BigInt(ANCHOR.getTime() / 1000), forecaster: 'det_v0' },
  });
  const sibling = keccak256(stringToHex('another report'));
  return {
    signer: account.address,
    row: {
      reportHash: hash,
      canonicalJson: cj,
      eip712Signature: signature,
      signerAddress: account.address,
      chainId: 4663,
      tokenAddress: TOKEN,
      reportTime: ANCHOR,
      forecaster: 'det_v0',
      commit: {
        txHash: '0x37574b3c792eecf81af77a940ad37cc64ddd277eb42b39ef001b499c11a4392a',
        blockNumber: 66_000_000n,
        merkleRoot: sortedPair(hash, sibling),
        leaves: [{ reportHash: hash, index: 0, proof: [sibling] }],
      },
    },
  };
}

// The block the audit found this replay committed in: 11h36m45s after its anchor.
const COMMIT_BLOCK_TIME = new Date('2026-09-19T01:24:19Z');

describe('buildReceipt', () => {
  it('serves the chain block time, the lag from the anchor, and eligibility per outcome', async () => {
    const { row } = await signedFixture();
    const r = buildReceipt(row, OUTCOMES, COMMIT_BLOCK_TIME, '0xF36F84a7B7DfFB952341d021db51bD76E54fDBEe');
    expect(r.commit.blockTime).toBe('2026-09-19T01:24:19.000Z');
    expect(r.commit.lagFromAnchorSec).toBe(11 * 3600 + 36 * 60 + 45);
    expect(r.outcomes.map((o) => [o.horizon, o.eligibility])).toEqual([
      ['1h', 'late'],
      ['6h', 'late'],
      ['24h', 'replay'],
    ]);
    expect(r.eip712.message.reportTime).toBe(ANCHOR.getTime() / 1000);
  });

  it('says the block time is unknown instead of guessing when the chain read failed', async () => {
    const { row } = await signedFixture();
    const r = buildReceipt(row, OUTCOMES, null, null);
    expect(r.commit.blockTime).toBeNull();
    expect(r.outcomes.every((o) => o.eligibility === 'missing_time')).toBe(true);
  });
});

describe('verifyReceiptOffline', () => {
  const run = async (mutate?: (r: Receipt) => void, expectedSigner?: string) => {
    const { row, signer } = await signedFixture();
    const receipt = buildReceipt(row, OUTCOMES, COMMIT_BLOCK_TIME, null);
    mutate?.(receipt);
    const checks = await verifyReceiptOffline(receipt, row.reportHash, expectedSigner ?? signer);
    return Object.fromEntries(checks.map((c) => [c.name, c.ok]));
  };

  it('passes hash, signature and Merkle checks on a genuine receipt', async () => {
    expect(await run()).toEqual({ hash: true, signature: true, merkle: true });
  });

  it('fails when the displayed forecast was edited — the bytes no longer produce the hash', async () => {
    const r = await run((x) => {
      x.canonicalJson = x.canonicalJson.replace('0.9972', '0.1000');
    });
    expect(r.hash).toBe(false);
    expect(r.signature).toBe(false);
  });

  it('rebuilds the signed message from the bytes, so a doctored eip712.message changes nothing', async () => {
    const r = await run((x) => {
      x.eip712.message.forecaster = 'something_else';
    });
    expect(r).toEqual({ hash: true, signature: true, merkle: true });
  });

  it('fails the signature against any signer but the published one', async () => {
    const r = await run(undefined, privateKeyToAccount(generatePrivateKey()).address);
    expect(r.signature).toBe(false);
  });

  it('fails the Merkle check when the proof does not fold to the root', async () => {
    const r = await run((x) => {
      x.commit.proof = [keccak256(stringToHex('wrong sibling'))];
    });
    expect(r.merkle).toBe(false);
  });
});

describe('eligibilityFromChain', () => {
  it('recomputes each outcome from the chain timestamp, not the server label', async () => {
    const { row } = await signedFixture();
    const receipt = buildReceipt(row, OUTCOMES, COMMIT_BLOCK_TIME, null);
    receipt.outcomes.forEach((o) => (o.eligibility = 'eligible')); // a lying server
    expect(eligibilityFromChain(receipt, COMMIT_BLOCK_TIME).map((e) => e.eligibility)).toEqual(['late', 'late', 'replay']);
  });
});

describe('GET /v1/receipt/:hash', () => {
  const HASH = `0x${'ab'.repeat(32)}`;

  it('serves the injected receipt', async () => {
    const { row } = await signedFixture();
    const receipt = buildReceipt(row, OUTCOMES, COMMIT_BLOCK_TIME, null);
    const app = buildServer({ receiptReader: async () => receipt });
    const res = await app.inject({ method: 'GET', url: `/v1/receipt/${HASH}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().canonicalJson).toBe(row.canonicalJson);
    await app.close();
  });

  it('404s an unknown hash and 400s a malformed one', async () => {
    const app = buildServer({ receiptReader: async () => null });
    expect((await app.inject({ method: 'GET', url: `/v1/receipt/${HASH}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/receipt/0x1234' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('rootInTxLogs', () => {
  const REGISTRY = '0xF36F84a7B7DfFB952341d021db51bD76E54fDBEe';
  const ROOT = keccak256(stringToHex('root'));
  const event = parseAbiItem('event BatchCommitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 leafCount, uint256 timestamp)');
  const log = (address: string, root: Hex) => ({
    address,
    topics: encodeEventTopics({ abi: [event], eventName: 'BatchCommitted', args: { batchId: 7n } }) as Hex[],
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [root, 42n, 1_789_000_000n]),
  });

  it('finds the root in a BatchCommitted event emitted by the registry', () => {
    expect(rootInTxLogs([log(REGISTRY, ROOT)], REGISTRY, ROOT)).toBe(true);
  });

  it('ignores the same event from any other contract, and a different root', () => {
    expect(rootInTxLogs([log('0x000000000000000000000000000000000000dEaD', ROOT)], REGISTRY, ROOT)).toBe(false);
    expect(rootInTxLogs([log(REGISTRY, keccak256(stringToHex('other')))], REGISTRY, ROOT)).toBe(false);
  });
});
