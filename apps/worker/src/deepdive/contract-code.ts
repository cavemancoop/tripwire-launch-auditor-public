/**
 * `contract_code(address)` — runtime bytecode hash + EIP-1967 proxy resolution
 * for the deep-dive's frozen target packet (spec §8.2: "runtime hash,
 * proxy/implementation resolution"). RPC-only; no Blockscout at runtime.
 */
import { keccak256, type Hex } from 'viem';

/** keccak256("eip1967.proxy.implementation") − 1 */
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
/** keccak256("eip1967.proxy.admin") − 1 */
export const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as const;
/** keccak256("eip1967.proxy.beacon") − 1 */
export const EIP1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const;

export interface CodeClient {
  getCode(args: { address: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Hex; slot: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
}

export interface ContractCode {
  address: string;
  block: string | null;
  /** keccak256 of the deployed runtime bytecode; null when there is no code */
  codeHash: string | null;
  /** runtime bytecode length in bytes */
  codeSize: number;
  isContract: boolean;
  /** any EIP-1967 slot is non-zero */
  isProxy: boolean;
  /** address in the EIP-1967 implementation slot, if set */
  implementation: string | null;
  /** address in the EIP-1967 admin slot, if set */
  admin: string | null;
  /** address in the EIP-1967 beacon slot, if set */
  beacon: string | null;
}

const ZERO_WORD = `0x${'00'.repeat(32)}`;

/** last 20 bytes of a 32-byte storage word → checksummed-lowercase address, or null when zero */
function wordToAddress(word: Hex | undefined): string | null {
  if (!word || word === ZERO_WORD || word.length < 66) return null;
  const addr = `0x${word.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(addr) ? null : addr;
}

export async function resolveContractCode(
  client: CodeClient,
  address: string,
  blockNumber?: bigint,
): Promise<ContractCode> {
  const addr = address.toLowerCase() as Hex;
  const code = await client.getCode({ address: addr, blockNumber });
  const hasCode = !!code && code !== '0x';
  const codeSize = hasCode ? (code!.length - 2) / 2 : 0;

  const result: ContractCode = {
    address: addr,
    block: blockNumber === undefined ? null : String(blockNumber),
    codeHash: hasCode ? keccak256(code as Hex) : null,
    codeSize,
    isContract: hasCode,
    isProxy: false,
    implementation: null,
    admin: null,
    beacon: null,
  };
  if (!hasCode) return result;

  const [impl, admin, beacon] = await Promise.all([
    client.getStorageAt({ address: addr, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber }),
    client.getStorageAt({ address: addr, slot: EIP1967_ADMIN_SLOT, blockNumber }),
    client.getStorageAt({ address: addr, slot: EIP1967_BEACON_SLOT, blockNumber }),
  ]);
  result.implementation = wordToAddress(impl);
  result.admin = wordToAddress(admin);
  result.beacon = wordToAddress(beacon);
  result.isProxy = !!(result.implementation || result.admin || result.beacon);
  return result;
}
