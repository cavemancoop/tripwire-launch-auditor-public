import { createWalletClient, http, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodChain } from './chain';

/** Wallet client for the gas wallet — signs & sends commit transactions. */
export function getWalletClient(rpcUrl: string, privateKey: Hex): WalletClient {
  if (!rpcUrl) throw new Error('getWalletClient: rpcUrl is empty');
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: robinhoodChain,
    transport: http(rpcUrl, { timeout: 30_000, retryCount: 5 }),
  });
}

/** CommitRegistry ABI (spec §6). */
export const COMMIT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'commitBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'leafCount', type: 'uint256' },
    ],
    outputs: [{ name: 'batchId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'commitArtifact',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'kind', type: 'bytes32' },
      { name: 'hash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rotateOwner',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'batchCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'BatchCommitted',
    inputs: [
      { name: 'batchId', type: 'uint256', indexed: true },
      { name: 'merkleRoot', type: 'bytes32', indexed: false },
      { name: 'leafCount', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ArtifactCommitted',
    inputs: [
      { name: 'kind', type: 'bytes32', indexed: true },
      { name: 'hash', type: 'bytes32', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;
