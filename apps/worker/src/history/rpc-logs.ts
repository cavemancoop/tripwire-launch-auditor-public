import { getLogsChunked } from '@launch-auditor/chain';
import type { Address, Hex } from 'viem';
import { TRANSFER_TOPIC0, addressToTopic, topicToAddress, transferValue } from '../watcher/erc20';
import { withRetry } from '../watcher/retry';
import type { AddressHistoryProvider, HistoryWindow, TokenTransfer } from './provider';

export interface RpcLogsHistoryClient {
  request: Parameters<typeof getLogsChunked>[0]['request'];
}

const byOrder = (a: TokenTransfer, b: TokenTransfer): number =>
  a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex;

/**
 * `AddressHistoryProvider` over `eth_getLogs` on ERC-20 `Transfer`, filtered by
 * the indexed `from` / `to` topic. Chunked at `maxRange`; backs off on ordofi's
 * transient errors. Without a `token` filter it scans every contract's Transfer
 * logs in the window, so keep windows small when `token` is omitted.
 */
export class RpcLogsAddressHistory implements AddressHistoryProvider {
  constructor(
    private readonly client: RpcLogsHistoryClient,
    private readonly maxRange: number,
  ) {}

  private async query(
    topics: (Hex | Hex[] | null)[],
    w: HistoryWindow,
  ): Promise<TokenTransfer[]> {
    const logs = await withRetry(
      () =>
        getLogsChunked(this.client, {
          address: w.token ? (w.token as Address) : undefined,
          topics,
          fromBlock: w.fromBlock,
          toBlock: w.toBlock,
          maxRange: this.maxRange,
        }),
      { tries: 4, delayMs: 2000 },
    );
    return logs
      .map((l): TokenTransfer | null => {
        const from = l.topics[1] ? topicToAddress(l.topics[1]) : null;
        const to = l.topics[2] ? topicToAddress(l.topics[2]) : null;
        if (!from || !to) return null;
        return {
          token: l.address.toLowerCase(),
          from,
          to,
          value: transferValue(l.data),
          block: BigInt(l.blockNumber),
          logIndex: Number(l.logIndex),
          txHash: l.transactionHash ?? null,
        };
      })
      .filter((t): t is TokenTransfer => t !== null)
      .sort(byOrder);
  }

  inboundTransfers(address: string, w: HistoryWindow): Promise<TokenTransfer[]> {
    return this.query([TRANSFER_TOPIC0 as Hex, null, addressToTopic(address)], w);
  }

  outboundTransfers(address: string, w: HistoryWindow): Promise<TokenTransfer[]> {
    return this.query([TRANSFER_TOPIC0 as Hex, addressToTopic(address)], w);
  }

  async tokenActivity(address: string, w: HistoryWindow): Promise<TokenTransfer[]> {
    const [inb, outb] = await Promise.all([
      this.inboundTransfers(address, w),
      this.outboundTransfers(address, w),
    ]);
    const seen = new Set<string>();
    return [...inb, ...outb]
      .filter((t) => {
        const k = `${t.block}-${t.logIndex}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort(byOrder);
  }

  async firstErc20Funder(
    address: string,
    w: Omit<HistoryWindow, 'token'>,
  ): Promise<string | null> {
    const inb = await this.inboundTransfers(address, w);
    const first = inb.find((t) => t.from !== '0x0000000000000000000000000000000000000000');
    return first?.from ?? null;
  }
}
