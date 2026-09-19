import type { Hex } from 'viem';

/** Transfer(address indexed from, address indexed to, uint256 value) */
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/** Approval(address indexed owner, address indexed spender, uint256 value) */
export const APPROVAL_TOPIC0 =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925' as const;

/** left-pad a 20-byte address to a 32-byte log topic */
export function addressToTopic(addr: string): Hex {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as Hex;
}

/** the low 20 bytes of a 32-byte topic, lowercased */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** decode a Transfer log's uint256 value from `data` */
export function transferValue(data: string): bigint {
  return data && data !== '0x' ? BigInt(data) : 0n;
}
