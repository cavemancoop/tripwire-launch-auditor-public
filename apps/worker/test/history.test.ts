import { describe, expect, it, vi } from 'vitest';
import { RpcLogsAddressHistory } from '../src/history';
import { toFirstInboundLookup } from '../src/history/provider';
import { addressToTopic, TRANSFER_TOPIC0 } from '../src/watcher/erc20';

const TOKEN = '0x1111111111111111111111111111111111111111';
const ME = '0x2222222222222222222222222222222222222222';
const A = '0x3333333333333333333333333333333333333333';
const B = '0x4444444444444444444444444444444444444444';
const ZERO = '0x0000000000000000000000000000000000000000';

const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const tlog = (from: string, to: string, v: bigint, block: bigint, logIndex: number) => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC0, addressToTopic(from), addressToTopic(to)],
  data: word(v),
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  transactionHash: `0x${'ab'.repeat(32)}`,
});

// mint to A@10, A funds ME@20, ME sends B@30, B sends ME@25
const LOGS = [
  tlog(ZERO, A, 1000n, 10n, 0),
  tlog(A, ME, 400n, 20n, 1),
  tlog(ME, B, 100n, 30n, 0),
  tlog(B, ME, 50n, 25n, 2),
];

/** routes by topic position: topics[2] set => inbound (to == addr); else outbound (from == addr) */
function client(addr: string) {
  const t = addressToTopic(addr);
  return {
    request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
      if (method !== 'eth_getLogs') throw new Error(method);
      const topics = params[0].topics as unknown[];
      const wantInbound = topics.length >= 3 && topics[2] === t;
      const wantOutbound = topics[1] === t;
      return LOGS.filter((l) => {
        const from = l.topics[1];
        const to = l.topics[2];
        if (wantInbound) return to === addressToTopic(addr);
        if (wantOutbound) return from === addressToTopic(addr);
        return false;
      });
    }),
  };
}

describe('RpcLogsAddressHistory', () => {
  it('returns inbound transfers oldest-first', async () => {
    const h = new RpcLogsAddressHistory(client(ME) as never, 2000);
    const inb = await h.inboundTransfers(ME, { token: TOKEN, fromBlock: 0n, toBlock: 100n });
    expect(inb.map((t) => Number(t.block))).toEqual([20, 25]);
    expect(inb[0]!.from).toBe(A);
    expect(inb[0]!.value).toBe(400n);
  });

  it('returns outbound transfers', async () => {
    const h = new RpcLogsAddressHistory(client(ME) as never, 2000);
    const outb = await h.outboundTransfers(ME, { token: TOKEN, fromBlock: 0n, toBlock: 100n });
    expect(outb.map((t) => Number(t.block))).toEqual([30]);
    expect(outb[0]!.to).toBe(B);
  });

  it('tokenActivity merges and de-dups in order', async () => {
    const h = new RpcLogsAddressHistory(client(ME) as never, 2000);
    const act = await h.tokenActivity(ME, { token: TOKEN, fromBlock: 0n, toBlock: 100n });
    expect(act.map((t) => Number(t.block))).toEqual([20, 25, 30]);
  });

  it('firstErc20Funder is the earliest non-mint sender', async () => {
    const h = new RpcLogsAddressHistory(client(ME) as never, 2000);
    expect(await h.firstErc20Funder(ME, { fromBlock: 0n, toBlock: 100n })).toBe(A);
  });

  it('toFirstInboundLookup adapts to the cluster interface', async () => {
    const h = new RpcLogsAddressHistory(client(ME) as never, 2000);
    const lookup = toFirstInboundLookup(h, { fromBlock: 0n, toBlock: 100n });
    expect(await lookup.firstFunder(ME)).toBe(A);
  });
});
