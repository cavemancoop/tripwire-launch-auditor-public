import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import {
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  resolveContractCode,
  type CodeClient,
} from '../src/deepdive/contract-code';

const ZERO = `0x${'00'.repeat(32)}` as Hex;
const word = (addr: string): Hex => `0x${'00'.repeat(12)}${addr.replace(/^0x/, '')}` as Hex;

function client(over: Partial<{ code: Hex | undefined; slots: Record<string, Hex> }>): CodeClient {
  const slots = over.slots ?? {};
  return {
    getCode: async () => ('code' in over ? over.code : ('0x' as Hex)),
    getStorageAt: async ({ slot }) => slots[slot.toLowerCase()] ?? ZERO,
  };
}

describe('resolveContractCode', () => {
  it('reports an EOA (no code)', async () => {
    const c = await resolveContractCode(client({ code: '0x' as Hex }), '0xabc0000000000000000000000000000000000001');
    expect(c).toMatchObject({ isContract: false, isProxy: false, codeHash: null, codeSize: 0 });
  });

  it('hashes runtime bytecode and reports size', async () => {
    const code = '0x6080604052' as Hex; // 5 bytes
    const c = await resolveContractCode(client({ code }), '0xABC0000000000000000000000000000000000002');
    expect(c.isContract).toBe(true);
    expect(c.codeSize).toBe(5);
    expect(c.codeHash).toBe(keccak256(code));
    expect(c.isProxy).toBe(false);
    expect(c.address).toBe('0xabc0000000000000000000000000000000000002');
  });

  it('resolves EIP-1967 implementation / admin / beacon slots', async () => {
    const impl = '0x1111111111111111111111111111111111111111';
    const admin = '0x2222222222222222222222222222222222222222';
    const beacon = '0x3333333333333333333333333333333333333333';
    const c = await resolveContractCode(
      client({
        code: '0xdeadbeef' as Hex,
        slots: {
          [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: word(impl),
          [EIP1967_ADMIN_SLOT.toLowerCase()]: word(admin),
          [EIP1967_BEACON_SLOT.toLowerCase()]: word(beacon),
        },
      }),
      '0xabc0000000000000000000000000000000000003',
      123n,
    );
    expect(c).toMatchObject({ isProxy: true, implementation: impl, admin, beacon, block: '123' });
  });

  it('treats an all-zero slot word as unset', async () => {
    const c = await resolveContractCode(
      client({ code: '0xabcd' as Hex, slots: { [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: ZERO } }),
      '0xabc0000000000000000000000000000000000004',
    );
    expect(c.isProxy).toBe(false);
    expect(c.implementation).toBeNull();
  });
});
