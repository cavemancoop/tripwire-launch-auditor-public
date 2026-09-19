import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { buildTargetPacket, type DeepdiveTarget, type PacketClient } from '../src/deepdive/packet';
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/deepdive/contract-code';

const TOKEN = '0x00000000000000000000000000000000dec0ded1';
const IMPL = '0x00000000000000000000000000000000111111a1';
const ZERO = `0x${'00'.repeat(32)}` as Hex;
const word = (a: string): Hex => `0x${'00'.repeat(12)}${a.replace(/^0x/, '')}` as Hex;

const target: DeepdiveTarget = {
  chainId: 4663,
  tokenAddress: TOKEN.toUpperCase(),
  quoteAddress: '0xQUOTE00000000000000000000000000000000abcd',
  creatorAddress: '0xC0FFEE0000000000000000000000000000000001',
  launchBlock: 1000n,
  launchTxHash: '0xlaunch',
  launchAt: new Date('2026-09-01T00:00:00Z'),
  source: 'pons',
  pools: [
    { kind: 'v4', poolAddress: null, poolId: '0xpool', feeHundredthsBip: 3000, tickSpacing: 60, hooks: null, feeSuspect: false },
  ],
};

function client(over: {
  chainId?: number;
  code?: Hex;
  implCode?: Hex;
  slots?: Record<string, Hex>;
}): PacketClient {
  const slots = over.slots ?? {};
  return {
    getChainId: async () => over.chainId ?? 4663,
    getBlock: async () => ({ number: 2000n, hash: '0xblockhash' as Hex, timestamp: 1_760_000_000n }),
    getCode: async ({ address }) =>
      address.toLowerCase() === IMPL.toLowerCase() ? (over.implCode ?? ('0xfeed' as Hex)) : (over.code ?? ('0x' as Hex)),
    getStorageAt: async ({ slot }) => slots[slot.toLowerCase()] ?? ZERO,
  };
}

describe('buildTargetPacket', () => {
  it('pins the report block and flags a chain-id match', async () => {
    const p = await buildTargetPacket(client({ code: '0x6001' as Hex }), target);
    expect(p.chainIdMatches).toBe(true);
    expect(p.rpcChainId).toBe(4663);
    expect(p.reportBlock).toEqual({
      number: '2000',
      hash: '0xblockhash',
      timestampUtc: new Date(1_760_000_000_000).toISOString(),
    });
    expect(p.tokenAddress).toBe(TOKEN); // lower-cased
    expect(p.code.codeHash).toBe(keccak256('0x6001'));
    expect(p.implementationCode).toBeNull();
    expect(p.launch).toEqual({ block: '1000', txHash: '0xlaunch', at: '2026-09-01T00:00:00.000Z' });
  });

  it('flags a chain-id mismatch', async () => {
    const p = await buildTargetPacket(client({ chainId: 1, code: '0x60' as Hex }), target);
    expect(p.chainIdMatches).toBe(false);
    expect(p.rpcChainId).toBe(1);
  });

  it('resolves the implementation code for an EIP-1967 proxy', async () => {
    const p = await buildTargetPacket(
      client({
        code: '0xdead' as Hex,
        implCode: '0xbeef' as Hex,
        slots: { [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: word(IMPL) },
      }),
      target,
    );
    expect(p.code.isProxy).toBe(true);
    expect(p.code.implementation).toBe(IMPL);
    expect(p.implementationCode?.codeHash).toBe(keccak256('0xbeef'));
  });
});
