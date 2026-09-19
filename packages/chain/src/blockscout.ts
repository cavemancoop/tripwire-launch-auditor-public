/**
 * Minimal typed client for the Blockscout v2 REST API on Robinhood Chain.
 * Base URL comes from env (BLOCKSCOUT_API_BASE); default matches the build guide.
 * `fetch` is injectable so tests run against recorded fixtures with no network.
 */

export const DEFAULT_BLOCKSCOUT_BASE =
  'https://robinhoodchain.blockscout.com/api/v2';

export interface BlockscoutClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface BlockscoutAddress {
  hash: string;
  is_contract: boolean;
  is_verified?: boolean | null;
  creation_transaction_hash?: string | null;
  creator_address_hash?: string | null;
  token?: { type?: string | null } | null;
}

export interface BlockscoutAddressParam {
  hash: string;
}

export interface BlockscoutTransaction {
  hash: string;
  block_number: number | null;
  from: BlockscoutAddressParam;
  to: BlockscoutAddressParam | null;
  method?: string | null;
  status?: string | null;
  timestamp?: string | null;
}

export interface BlockscoutPage<T> {
  items: T[];
  next_page_params: Record<string, unknown> | null;
}

export class BlockscoutClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BlockscoutClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BLOCKSCOUT_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Blockscout GET ${path} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  getAddress(hash: string): Promise<BlockscoutAddress> {
    return this.get<BlockscoutAddress>(`/addresses/${hash}`);
  }

  getAddressTransactions(hash: string): Promise<BlockscoutPage<BlockscoutTransaction>> {
    return this.get<BlockscoutPage<BlockscoutTransaction>>(
      `/addresses/${hash}/transactions`,
    );
  }

  getTransaction(hash: string): Promise<BlockscoutTransaction> {
    return this.get<BlockscoutTransaction>(`/transactions/${hash}`);
  }
}
