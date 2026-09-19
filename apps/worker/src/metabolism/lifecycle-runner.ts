/**
 * M5b-2 — the 60s Metabolism lifecycle runner (spec §8, adapted per the
 * 2026-09-09 CHANGELOG decisions).
 *
 * Every `METABOLISM_STATUS_POLL_SEC` seconds it polls `orbio_get_balance` +
 * `orbio_get_key_status`, computes the next transition with {@link decideLifecycle}
 * (a pure function driving `state.ts`'s machine), acts on it via the Orbio
 * wrappers, and appends a signed row to `lifecycle_log` for every transition and
 * one snapshot per tick ({@link LifecycleLogWriter}, hash-chained + agent-signed).
 *
 * Adaptations vs the pristine `state.ts` machine, all from the CHANGELOG:
 *  - a key holds no money; the account balance IS the quota. `claimSize` /
 *    `reserveR` are gone — the floor is a flat `RESERVE_USD`.
 *  - `balance − RESERVE_USD ≤ 0` → STARVED directly (NO rotate: a fresh key
 *    spends the same empty balance). Recovery: balance back above reserve → ACTIVE.
 *  - ROTATING is hygiene-only (key age ≥ `hygieneRotateDays`).
 *  - M5c: a ledger/provider gap is NOT a compromise. Each tick is an epoch
 *    (`reconcile.ts`): the provider's spend delta is graded against the sum of
 *    local token-priced estimates, the rows are relabelled
 *    `provider_reconciled_estimate`, and the discrepancy is published as the
 *    agent's own cost-forecast error. Only PHANTOM_SPEND — provider spend with
 *    zero local requests — revokes (→ NO_KEY, HALT until `pnpm orbio:auth`).
 *    A sustained estimator anomaly pauses inference via `billingStatus`; it
 *    never touches the key.
 */
import { Prisma, prisma } from '@launch-auditor/db';
import type { Hex } from 'viem';
import { loadEnv } from '../env';
import { recordFailure } from '../failures';
import {
  buildLifecycleEntry,
  GENESIS_HASH,
  signLifecycleEntry,
} from './lifecycle';
import {
  connectOrbio,
  orbioCreateKey,
  orbioGetBalance,
  orbioGetKeyStatus,
  orbioRevokeKey,
  type OrbioConnection,
} from './orbio-client';
import { getWalletClient } from '@launch-auditor/chain';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import type { PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveGatewayKey, walletGatewayKeyActive } from '../deepdive/openrouter';
import {
  activateCredit,
  activatedTodayUsd,
  activationDecision,
  creditHeldUsd,
  type ProtocolAddresses,
} from './credit-wallet';
import { gatewayGetKey, gatewayKeyToReading, metabolismSource, type MetabolismReading } from './gateway-reader';
import { reconcileIds, type IdsReconcile } from './ids-reconcile';
import { reconcileEpoch, type BillingStatus } from './reconcile';
import { keyManagementMode } from './session-seed';
import { applyReconciliation, totalSpendUsd, windowEstimate } from './spend-ledger';
import { nextState, type LifecycleEvent, type LifecycleState } from './state';
import {
  loadEncryptionKey,
  readOAuthBlob,
  tokenStorePath,
  updateOAuthBlob,
} from './token-store';

/* ────────────────────────── pure decision ────────────────────────── */

export interface LifecycleConfig {
  reserveUsd: number;
  lowWaterUsd: number;
  hygieneRotateDays: number;
  idsToleranceUsd: number;
  idsGraceUsd: number;
}

export interface LifecycleReading {
  state: LifecycleState;
  /** set after an IDS-triggered revoke; blocks auto-mint until a human re-auths */
  halted: boolean;
  balanceUsd: number;
  /** orbio_get_key_status.hasKey */
  hasKey: boolean;
  /** we hold this key's secret in the encrypted store (else it is unusable) */
  holdSecret: boolean;
  /** age of the current key in days, or null when there is no key */
  keyAgeDays: number | null;
  /** Σ MetabolismSpend.costUsd (local ledger) — kept for the lifecycle_log row */
  ledgerSpendUsd: number;
  /** orbio_get_balance.spent.usd (provider) — kept for the lifecycle_log row */
  providerSpendUsd: number;
  /** M5b-3: per-key baseline reconcile of the two above — informational since M5c */
  ids: IdsReconcile;
  /** M5c: this epoch saw provider spend with zero local requests — the compromise signal */
  phantomSpend?: boolean;
  /** M5c: effective billing state after the consecutive-anomaly threshold */
  billingStatus?: BillingStatus;
}

export type LifecycleDecision =
  | { kind: 'steady'; state: LifecycleState; reason: string }
  | {
      kind: 'transition';
      from: LifecycleState;
      to: LifecycleState;
      event: LifecycleEvent;
      reason: string;
      /** mint a fresh gateway key before recording the transition */
      mint?: boolean;
    }
  | { kind: 'rotate'; from: LifecycleState; reason: string }
  | { kind: 'revoke'; from: LifecycleState; reason: string };

const r2 = (n: number): string => n.toFixed(2);

/** Pure: given a live reading + config, what should the runner do this tick? */
export function decideLifecycle(r: LifecycleReading, cfg: LifecycleConfig): LifecycleDecision {
  const spendable = r.balanceUsd - cfg.reserveUsd;
  const S = r.state;

  // M5c: PHANTOM_SPEND — the provider charged us while we made no calls — is
  // the one signal that means someone else holds the key. It preempts everything
  // from any state that holds a key. An IDS ledger/provider gap no longer does:
  // that is the estimator being wrong, handled by `billingStatus`, not a revoke.
  if (r.phantomSpend && S !== 'NO_KEY' && S !== 'REVOKING') {
    return { kind: 'revoke', from: S, reason: 'phantom spend: provider charged with zero local requests this epoch' };
  }

  switch (S) {
    case 'REVOKING':
      // The runner completes REVOKING within the tick it enters it; only reached
      // if a process died mid-revoke.
      return { kind: 'transition', from: S, to: 'NO_KEY', event: 'REVOKED', reason: 'completing a pending revoke' };

    case 'NO_KEY':
      if (r.halted) {
        return { kind: 'steady', state: 'NO_KEY', reason: 'halted — awaiting a manual credential action (pnpm orbio:auth)' };
      }
      if (spendable <= 0) {
        return {
          kind: 'transition',
          from: S,
          to: 'STARVED',
          event: 'NO_CREDITS',
          reason: `balance $${r2(r.balanceUsd)} ≤ reserve $${r2(cfg.reserveUsd)} — nothing to serve`,
        };
      }
      return {
        kind: 'transition',
        from: S,
        to: 'ACTIVE',
        event: 'KEY_CLAIMED',
        mint: true,
        reason: `minted a gateway key (balance $${r2(r.balanceUsd)}, spendable $${r2(spendable)})`,
      };

    case 'ROTATING':
      return { kind: 'transition', from: S, to: 'ACTIVE', event: 'KEY_CLAIMED', mint: true, reason: 'completing a pending rotation' };

    case 'STARVED':
      if (spendable > 0) {
        return r.hasKey && r.holdSecret
          ? {
              kind: 'transition',
              from: S,
              to: 'ACTIVE',
              event: 'KEY_CLAIMED',
              reason: `balance recovered to $${r2(r.balanceUsd)} — key still valid`,
            }
          : {
              kind: 'transition',
              from: S,
              to: 'ACTIVE',
              event: 'KEY_CLAIMED',
              mint: true,
              reason: `balance recovered to $${r2(r.balanceUsd)} — minting`,
            };
      }
      return {
        kind: 'steady',
        state: 'STARVED',
        reason: `waiting for accrual — balance $${r2(r.balanceUsd)}, reserve $${r2(cfg.reserveUsd)}`,
      };

    case 'ACTIVE':
    case 'DRAINING': {
      if (!r.hasKey) {
        return { kind: 'transition', from: S, to: 'NO_KEY', event: 'REVOKED', reason: 'provider reports no key — lost outside the runner' };
      }
      if (!r.holdSecret) {
        return { kind: 'revoke', from: S, reason: 'key present at provider but its secret is not in the store — revoking to remint' };
      }
      if (r.keyAgeDays != null && r.keyAgeDays >= cfg.hygieneRotateDays) {
        return { kind: 'rotate', from: S, reason: `key age ${r.keyAgeDays.toFixed(1)}d ≥ ${cfg.hygieneRotateDays}d (hygiene)` };
      }
      if (spendable <= 0) {
        return {
          kind: 'transition',
          from: S,
          to: 'STARVED',
          event: 'NO_CREDITS',
          reason: `balance $${r2(r.balanceUsd)} ≤ reserve $${r2(cfg.reserveUsd)} — no rotate (a new key spends the same balance)`,
        };
      }
      if (r.balanceUsd < cfg.lowWaterUsd) {
        return S === 'ACTIVE'
          ? {
              kind: 'transition',
              from: S,
              to: 'DRAINING',
              event: 'LOW_BALANCE',
              reason: `balance $${r2(r.balanceUsd)} < low-water $${r2(cfg.lowWaterUsd)} (still serving, flagged)`,
            }
          : { kind: 'steady', state: 'DRAINING', reason: `draining — balance $${r2(r.balanceUsd)}` };
      }
      return S === 'DRAINING'
        ? {
            kind: 'transition',
            from: S,
            to: 'ACTIVE',
            event: 'STATUS_OK',
            reason: `balance recovered to $${r2(r.balanceUsd)} (≥ low-water $${r2(cfg.lowWaterUsd)})`,
          }
        : {
            kind: 'steady',
            state: 'ACTIVE',
            reason: `ok — balance $${r2(r.balanceUsd)}, key age ${r.keyAgeDays != null ? `${r.keyAgeDays.toFixed(1)}d` : 'unavailable'}`,
          };
    }
  }
}

/** Warn (do not throw) when the adapted decision diverges from the reference machine. */
export function checkAgainstStateMachine(from: LifecycleState, event: LifecycleEvent, to: LifecycleState): boolean {
  const n = nextState(from, event);
  const ok = n?.state === to;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn(`[metabolism] adapted transition ${from} --${event}--> ${to} diverges from state.ts (got ${n?.state ?? 'null'})`);
  }
  return ok;
}

/**
 * Observe mode (a seeded session on an ephemeral container — `session-seed.ts`):
 * keep every reading and every non-acting transition, but turn anything that
 * would call `orbio_create_key` / `orbio_revoke_key` into a logged snapshot.
 *
 * A pending mint is the one case with a non-acting equivalent: if the provider
 * already has a key and we hold its secret (the operator's `ORBIO_API_KEY`),
 * the transition is recorded as adopting that key instead of minting one.
 */
export function restrictToObserve(d: LifecycleDecision, r: LifecycleReading): LifecycleDecision {
  const note = 'observe mode — key management stays with the operator (pnpm orbio:auth)';
  if (d.kind === 'steady') return d;
  if (d.kind === 'transition') {
    if (!d.mint) return d;
    if (r.hasKey && r.holdSecret) {
      return { ...d, mint: false, reason: `adopted the operator-provisioned key instead of minting (${note})` };
    }
    return { kind: 'steady', state: r.state, reason: `would mint: ${d.reason} — ${note}` };
  }
  return { kind: 'steady', state: r.state, reason: `would ${d.kind}: ${d.reason} — ${note}` };
}

/* ─────────────────────── signed lifecycle_log writer ─────────────────────── */

export interface LifecycleRowInput {
  isSnapshot: boolean;
  prevState: LifecycleState | null;
  newState: LifecycleState;
  reason: string;
  keyId?: string | null;
  keyHashPrefix?: string | null;
  balanceUsd?: number | null;
  reserveUsd?: number | null;
  ledgerSpendUsd?: number | null;
  providerSpendUsd?: number | null;
  idsMismatch?: boolean;
  /** M5c — stored, not folded into the signed body (keeps every older row verifiable) */
  billingStatus?: BillingStatus | null;
}

export interface PersistedLifecycleRow {
  id: string;
  prevHash: Hex;
  bodyHash: Hex;
  signature: Hex;
  at: string;
}

/** The record handed to the persistence layer — the full DB row minus `id`/indexes. */
export interface LifecyclePersistRecord {
  isSnapshot: boolean;
  prevState: LifecycleState | null;
  newState: LifecycleState;
  reason: string;
  keyId: string | null;
  keyHashPrefix: string | null;
  balanceUsd: number | null;
  keyRemainingUsd: null;
  reserveUsd: number | null;
  ledgerSpendUsd: number | null;
  providerSpendUsd: number | null;
  idsMismatch: boolean;
  billingStatus: string | null;
  prevHash: string;
  bodyHash: string;
  signature: string;
  createdAt: Date;
}

export type LifecyclePersist = (record: LifecyclePersistRecord) => Promise<{ id: string }>;

/** The chain moved on since this writer last looked — another writer appended first. */
export class HeadMovedError extends Error {
  constructor(readonly head: Hex) {
    super(`lifecycle head moved to ${head}`);
  }
}

/** Arbitrary constant: one advisory-lock key for every lifecycle_log writer. */
const LIFECYCLE_LOCK_KEY = 4663_0001;

/**
 * Appends under a Postgres advisory lock, checking the row's prevHash against
 * the real head inside the same transaction. During a deploy the old and new
 * worker containers both run for a while; with only an in-memory head they
 * each appended onto the same parent and forked the chain (2026-09-19, rows
 * 230/231). Now the second writer gets HeadMovedError and re-chains.
 */
const prismaPersist: LifecyclePersist = async (record) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIFECYCLE_LOCK_KEY})`;
    const last = await tx.lifecycleLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { bodyHash: true } });
    const head = (last?.bodyHash as Hex | undefined) ?? GENESIS_HASH;
    if (head !== record.prevHash) throw new HeadMovedError(head);
    const row = await tx.lifecycleLog.create({
      data: record as Prisma.LifecycleLogUncheckedCreateInput,
      select: { id: true },
    });
    return { id: row.id };
  });

/**
 * Appends hash-chained, agent-signed rows to `lifecycle_log`. Keeps the running
 * `prevHash` in memory so several appends in one tick chain correctly; seed it
 * from the last DB row via {@link LifecycleLogWriter.fromDb}.
 */
export class LifecycleLogWriter {
  private prevHash: Hex;

  constructor(
    private readonly agentPrivateKey: Hex,
    seedPrevHash: Hex,
    private readonly persist: LifecyclePersist = prismaPersist,
  ) {
    this.prevHash = seedPrevHash;
  }

  static async fromDb(agentPrivateKey: Hex, persist: LifecyclePersist = prismaPersist): Promise<LifecycleLogWriter> {
    const last = await prisma.lifecycleLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { bodyHash: true },
    });
    return new LifecycleLogWriter(agentPrivateKey, (last?.bodyHash as Hex) ?? GENESIS_HASH, persist);
  }

  get head(): Hex {
    return this.prevHash;
  }

  async append(input: LifecycleRowInput): Promise<PersistedLifecycleRow> {
    try {
      return await this.appendOnce(input);
    } catch (err) {
      if (!(err instanceof HeadMovedError)) throw err;
      // another writer appended first: chain onto its row, re-sign, try once more
      this.prevHash = err.head;
      return this.appendOnce(input);
    }
  }

  private async appendOnce(input: LifecycleRowInput): Promise<PersistedLifecycleRow> {
    const at = new Date();
    const entry = buildLifecycleEntry(
      {
        prevState: input.prevState,
        newState: input.newState,
        reason: input.reason,
        isSnapshot: input.isSnapshot,
        keyHashPrefix: input.keyHashPrefix ?? undefined,
        balanceUsd: input.balanceUsd ?? undefined,
        reserveUsd: input.reserveUsd ?? undefined,
        ledgerSpendUsd: input.ledgerSpendUsd ?? undefined,
        providerSpendUsd: input.providerSpendUsd ?? undefined,
        idsMismatch: input.idsMismatch ?? false,
        at: at.toISOString(),
      },
      this.prevHash,
    );
    const signature = await signLifecycleEntry(entry.bodyHash, this.agentPrivateKey);
    const { id } = await this.persist({
      isSnapshot: input.isSnapshot,
      prevState: input.prevState,
      newState: input.newState,
      reason: input.reason,
      keyId: input.keyId ?? null,
      keyHashPrefix: input.keyHashPrefix ?? null,
      balanceUsd: input.balanceUsd ?? null,
      keyRemainingUsd: null,
      reserveUsd: input.reserveUsd ?? null,
      ledgerSpendUsd: input.ledgerSpendUsd ?? null,
      providerSpendUsd: input.providerSpendUsd ?? null,
      idsMismatch: input.idsMismatch ?? false,
      billingStatus: input.billingStatus ?? null,
      prevHash: this.prevHash,
      bodyHash: entry.bodyHash,
      signature,
      createdAt: at,
    });
    this.prevHash = entry.bodyHash;
    return { id, prevHash: entry.prevHash, bodyHash: entry.bodyHash, signature, at: entry.at };
  }
}

/* ───────────────────────────── the 60s loop ───────────────────────────── */

function samePrefix(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.slice(0, 14) === b.slice(0, 14);
}

export interface LifecycleLoopDeps {
  connect?: () => Promise<OrbioConnection>;
  writer?: LifecycleLogWriter;
}

export async function runLifecycleLoop(
  signal: { stopped: boolean },
  deps: LifecycleLoopDeps = {},
): Promise<void> {
  const env = loadEnv();
  if (!env.agentPrivateKey) {
    // eslint-disable-next-line no-console
    console.warn('[metabolism] AGENT_EIP712_PRIVATE_KEY not set — lifecycle loop not started');
    return;
  }
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    // eslint-disable-next-line no-console
    console.warn('[metabolism] TOKEN_ENCRYPTION_KEY not set — lifecycle loop not started');
    return;
  }
  const agentPk = env.agentPrivateKey;
  const cfg: LifecycleConfig = {
    reserveUsd: env.metabolismReserveUsd,
    lowWaterUsd: env.metabolismLowWaterUsd,
    hygieneRotateDays: env.metabolismHygieneRotateDays,
    idsToleranceUsd: env.metabolismIdsToleranceUsd,
    idsGraceUsd: env.metabolismIdsGraceUsd,
  };
  const intervalMs = env.metabolismStatusPollSec * 1000;
  const connect = deps.connect ?? (() => connectOrbio());
  const writer = deps.writer ?? (await LifecycleLogWriter.fromDb(agentPk));
  const storePath = tokenStorePath();
  const encKey = loadEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  const source = metabolismSource();
  // the gateway source has no key-management calls at all, so it is always observe
  const mode = source === 'gateway' ? 'observe' : keyManagementMode();

  const last = await prisma.lifecycleLog.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { newState: true, idsMismatch: true, billingStatus: true },
  });
  let state: LifecycleState = (last?.newState as LifecycleState) ?? 'NO_KEY';
  // halted = we revoked ourselves on a compromise signal; only a human re-auth clears it
  let halted =
    last?.newState === 'NO_KEY' && (last?.idsMismatch === true || last?.billingStatus === 'phantom');
  // M5c: a single anomalous epoch is noise; N in a row pauses inference
  let consecutiveAnomalies = 0;

  // eslint-disable-next-line no-console
  console.log(
    `[metabolism] lifecycle loop every ${env.metabolismStatusPollSec}s · reserve $${cfg.reserveUsd} · low-water $${cfg.lowWaterUsd} · hygiene ${cfg.hygieneRotateDays}d · source ${source} · keys ${mode} · start ${state}${halted ? ' (HALTED)' : ''}`,
  );

  // CREDIT activation (on-chain slice 3): only with the gateway source, a wallet
  // key, and the protocol addresses configured. In-memory pending guard; the
  // daily cap is read from the wallet's own Activated events, so it survives restarts.
  const activation =
    source === 'gateway' && /^(1|true|yes)$/i.test(process.env.CREDIT_ACTIVATE || '') && env.gasWalletPrivateKey && process.env.ORBIO_CREDIT_ADDRESS
      ? {
          addresses: { credit: process.env.ORBIO_CREDIT_ADDRESS as `0x${string}`, staking: (process.env.ORBIO_STAKING_ADDRESS || undefined) as `0x${string}` | undefined } satisfies ProtocolAddresses,
          wallet: privateKeyToAccount(env.gasWalletPrivateKey).address,
          lowWaterUsd: Number(process.env.CREDIT_ACTIVATE_LOW_WATER_USD || 2),
          chunkUsd: Number(process.env.CREDIT_ACTIVATE_CHUNK_USD || 5),
          dailyCapUsd: Number(process.env.CREDIT_ACTIVATE_DAILY_CAP_USD || env.deepdiveDailyCapUsd),
          // property 2's accrual window closes at 24h; refresh it before then
          // regardless of balance, or a cold window can never self-heal (see
          // the keep-warm note on ActivationInputs). Margin, not a schedule.
          keepWarmAfterMs: Number(process.env.CREDIT_ACTIVATE_KEEP_WARM_HOURS || 20) * 3_600_000,
        }
      : null;
  let lastActivation: { at: number; balanceBefore: number; amountUsd: number } | null = null;
  if (activation) {
    // eslint-disable-next-line no-console
    console.log(`[metabolism] CREDIT activation on for ${activation.wallet} · low-water $${activation.lowWaterUsd} · chunk $${activation.chunkUsd} · cap $${activation.dailyCapUsd}/day · keep-warm ${activation.keepWarmAfterMs / 3_600_000}h`);
  }
  // The last SELF-activation this agent recorded (Postgres, not a chain scan —
  // cheap on every tick). An operator activation (like the funding one) isn't
  // captured here, so this can under-count how "warm" the window really is;
  // that only makes the agent activate a little earlier than the bare
  // minimum, never later, which is the safe direction to be wrong in.
  const lastSelfActivationAt = async (): Promise<number | null> => {
    const row = await prisma.lifecycleLog.findFirst({
      where: { reason: { startsWith: 'activated $' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row ? row.createdAt.getTime() : null;
  };

  let conn: OrbioConnection | null = null;
  const dropConn = async (): Promise<void> => {
    if (conn) {
      await conn.close().catch(() => {});
      conn = null;
    }
  };

  while (!signal.stopped) {
    try {
      let c: OrbioConnection | null = null;
      let read: MetabolismReading;
      if (source === 'gateway') {
        try {
          read = gatewayKeyToReading(
            await gatewayGetKey({ baseUrl: env.orbioGatewayV1Url, apiKey: resolveGatewayKey() }),
          );
        } catch (e) {
          // A wallet-signature key is unknown to the gateway until the wallet's
          // first activation: that is "no account yet, balance 0", not an outage.
          if (!(walletGatewayKeyActive() && /-> 401/.test(e instanceof Error ? e.message : ''))) throw e;
          read = { balanceUsd: 0, providerSpendUsd: 0, status: { hasKey: false, prefix: null, createdAt: null } };
        }
      } else {
        if (!conn) conn = await connect();
        c = conn;
        const [b, s] = await Promise.all([orbioGetBalance(c.client), orbioGetKeyStatus(c.client)]);
        read = { balanceUsd: b.balance.usd, providerSpendUsd: b.spent.usd, status: s };
      }
      const { status } = read;

      if (activation) {
        const pending =
          lastActivation !== null &&
          Date.now() - lastActivation.at < 10 * 60_000 &&
          read.balanceUsd < lastActivation.balanceBefore + lastActivation.amountUsd * 0.5;
        if (lastActivation && !pending) lastActivation = null;
        const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit }) as unknown as PublicClient;
        const held = await creditHeldUsd(pub, activation.addresses.credit, activation.wallet);
        // cheap DB read (not RPC) — safe to do whenever the wallet holds CREDIT at all
        const msSinceLastActivation = !pending && held > 0 ? Date.now() - ((await lastSelfActivationAt()) ?? -Infinity) : null;
        const lowBalance = read.balanceUsd < activation.lowWaterUsd;
        const coldWindow = msSinceLastActivation !== null && msSinceLastActivation >= activation.keepWarmAfterMs;
        const needsCheck = !pending && held > 0 && (lowBalance || coldWindow);
        const today = needsCheck
          ? await activatedTodayUsd(pub, activation.addresses.credit, activation.wallet, 9_999n)
          : 0;
        const d = activationDecision({
          apiBalanceUsd: read.balanceUsd,
          creditHeldUsd: held,
          lowWaterUsd: activation.lowWaterUsd,
          chunkUsd: activation.chunkUsd,
          activatedTodayUsd: today,
          dailyCapUsd: activation.dailyCapUsd,
          pending,
          msSinceLastActivation,
          keepWarmAfterMs: activation.keepWarmAfterMs,
        });
        if (d.activate) {
          // mark pending before sending: a timeout must not become a second activation
          lastActivation = { at: Date.now(), balanceBefore: read.balanceUsd, amountUsd: d.amountUsd };
          const r = await activateCredit({
            wallet: getWalletClient(env.rpcUrl, env.gasWalletPrivateKey!),
            pub,
            addresses: activation.addresses,
            amountUsd: d.amountUsd,
          });
          const reason = `activated $${d.amountUsd.toFixed(2)} CREDIT -> AI balance (activation #${r.activationId ?? '?'}, tx ${r.txHash}) — ${d.reason}`;
          await writer.append({
            isSnapshot: false,
            prevState: state,
            newState: state,
            reason,
            idsMismatch: false,
            balanceUsd: read.balanceUsd,
            reserveUsd: cfg.reserveUsd,
            ledgerSpendUsd: await totalSpendUsd(),
            providerSpendUsd: read.providerSpendUsd,
            keyId: status.prefix,
            keyHashPrefix: status.prefix,
          });
          // eslint-disable-next-line no-console
          console.log(`[metabolism] ${reason}`);
        }
      }
      const ledgerSpendUsd = await totalSpendUsd();
      const providerSpendUsd = read.providerSpendUsd;
      const blob = readOAuthBlob(storePath, encKey);

      // Establish / refresh the per-key IDS baseline before reconciling, so the
      // first tick with a new key never trips.
      if (
        status.hasKey &&
        status.prefix &&
        (!blob.spendBaseline || blob.spendBaseline.keyPrefix !== status.prefix)
      ) {
        blob.spendBaseline = {
          keyPrefix: status.prefix,
          providerSpentUsd: providerSpendUsd,
          ledgerUsd: ledgerSpendUsd,
          at: new Date().toISOString(),
        };
        updateOAuthBlob(storePath, encKey, { spendBaseline: blob.spendBaseline });
        // eslint-disable-next-line no-console
        console.log(`[metabolism] IDS baseline set for ${status.prefix} (provider $${r2(providerSpendUsd)}, ledger $${r2(ledgerSpendUsd)})`);
      }

      const ids = reconcileIds({
        keyPrefix: status.prefix ?? null,
        providerSpentUsd: providerSpendUsd,
        ledgerSpendUsd,
        baseline: blob.spendBaseline ?? null,
        toleranceUsd: cfg.idsToleranceUsd,
        graceUsd: cfg.idsGraceUsd,
      });

      // ── M5c epoch reconciliation ────────────────────────────────────────
      // Grade this tick's provider delta against the local estimates recorded
      // since the last epoch. The factor relabels those rows; the discrepancy is
      // the estimator's error. Phantom (spend with no requests) is the only
      // compromise signal; a sustained anomaly pauses inference, never revokes.
      const epochAt = new Date();
      const [prevEpoch, prevPrevEpoch] = await prisma.metabolismEpoch.findMany({
        orderBy: { at: 'desc' },
        take: 2,
        select: { at: true, providerSpendUsd: true },
      });
      const providerSpendPrevUsd =
        prevEpoch?.providerSpendUsd ?? blob.spendBaseline?.providerSpentUsd ?? providerSpendUsd;
      // First epoch ever: start the window at the spend baseline (set this tick
      // or earlier), not the beginning of time. Otherwise every historical local
      // estimate is graded against one tick of provider delta, and the first row
      // reads as a -100% anomaly (seen in production 2026-09-16).
      const windowStart =
        prevEpoch?.at ?? (blob.spendBaseline?.at ? new Date(blob.spendBaseline.at) : epochAt);
      const win = await windowEstimate(windowStart, epochAt);
      const ep = reconcileEpoch({
        providerSpendNowUsd: providerSpendUsd,
        providerSpendPrevUsd,
        localEstimateUsd: win.estimatedUsd,
        requestCount: win.count,
        lagRequestCount: prevEpoch
          ? (await windowEstimate(prevPrevEpoch?.at ?? new Date(prevEpoch.at.getTime() - intervalMs), prevEpoch.at)).count
          : 0,
        anomalyPct: env.metabolismAnomalyPct,
        phantomToleranceUsd: env.metabolismPhantomToleranceUsd,
      });
      consecutiveAnomalies = ep.anomaly ? consecutiveAnomalies + 1 : 0;
      const billingStatus: BillingStatus = ep.phantom
        ? 'phantom'
        : consecutiveAnomalies >= env.metabolismAnomalyEpochs
          ? 'anomaly'
          : ep.billingStatus === 'anomaly'
            ? 'aggregate_only' // one bad window is logged, not acted on
            : ep.billingStatus;
      const epochRow = await prisma.metabolismEpoch.create({
        data: {
          at: epochAt,
          keyHashPrefix: blob.gatewayKeyPrefix ?? null,
          providerSpendUsd,
          providerDeltaUsd: ep.providerDeltaUsd,
          localEstimateUsd: ep.localEstimateUsd,
          requestCount: ep.requestCount,
          reconciliationFactor: ep.reconciliationFactor,
          discrepancyPct: ep.discrepancyPct,
          anomaly: ep.anomaly,
          phantom: ep.phantom,
          billingStatus,
        },
        select: { id: true },
      });
      await applyReconciliation({
        since: windowStart,
        until: epochAt,
        epochId: epochRow.id,
        factor: ep.reconciliationFactor,
      });
      if (ep.phantom || ep.anomaly) {
        // eslint-disable-next-line no-console
        console.warn(`[metabolism] ${ep.reason}${billingStatus === 'anomaly' ? ` — ${consecutiveAnomalies} consecutive, inference PAUSED` : ''}`);
      } else if (ep.requestCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[metabolism] epoch: ${ep.reason}`);
      }

      // Observe mode never writes a key to the store, so the key we hold is the
      // one inference actually uses: ORBIO_API_KEY (a seed carries no key).
      const heldKey = mode === 'observe' ? resolveGatewayKey() : blob.gatewayKey;
      const heldPrefix = mode === 'observe' ? heldKey : blob.gatewayKeyPrefix;
      // Gateway source: the gateway just authenticated our key to answer, so we hold
      // its secret by definition — prefix formats differ between key schemes.
      const holdSecret =
        source === 'gateway'
          ? status.hasKey
          : typeof heldKey === 'string' &&
            heldKey.length > 0 &&
            (!status.prefix || samePrefix(status.prefix, heldPrefix));

      const reading: LifecycleReading = {
        state,
        halted,
        balanceUsd: read.balanceUsd,
        hasKey: status.hasKey,
        holdSecret,
        keyAgeDays:
          status.hasKey && status.createdAt
            ? (Date.now() - Date.parse(status.createdAt)) / 86_400_000
            : null,
        ledgerSpendUsd,
        providerSpendUsd,
        ids,
        phantomSpend: ep.phantom,
        billingStatus,
      };

      const idsMismatch = ids.mismatch;
      const common = {
        balanceUsd: reading.balanceUsd,
        reserveUsd: cfg.reserveUsd,
        ledgerSpendUsd: reading.ledgerSpendUsd,
        providerSpendUsd: reading.providerSpendUsd,
        billingStatus,
        keyId: status.prefix ?? blob.gatewayKeyPrefix ?? null,
        keyHashPrefix: blob.gatewayKeyPrefix ?? (source === 'gateway' ? status.prefix : null),
      };

      const mint = async (why: string): Promise<string> => {
        if (!c) throw new Error('minting needs the MCP source (METABOLISM_SOURCE=mcp)');
        const created = await orbioCreateKey(c.client, {
          label: `launch-auditor ${new Date().toISOString().slice(0, 10)}`,
        });
        updateOAuthBlob(storePath, encKey, {
          gatewayKey: created.key,
          gatewayKeyPrefix: created.prefix,
          // fresh key ⇒ fresh IDS baseline (this tick's provider spend, current ledger Σ)
          spendBaseline: {
            keyPrefix: created.prefix,
            providerSpentUsd: providerSpendUsd,
            ledgerUsd: ledgerSpendUsd,
            at: new Date().toISOString(),
          },
        });
        // eslint-disable-next-line no-console
        console.log(`[metabolism] minted ${created.prefix} (${why})`);
        return created.prefix;
      };

      const decided = decideLifecycle(reading, cfg);
      const decision = mode === 'observe' ? restrictToObserve(decided, reading) : decided;
      if (decided.kind === 'revoke' && decision.kind === 'steady' && reading.phantomSpend) {
        // cannot revoke without managing keys; billingStatus=phantom already closes the deep-dive gate
        // eslint-disable-next-line no-console
        console.error(`[metabolism] PHANTOM SPEND in observe mode — NOT revoked, inference gated. ${decided.reason}`);
      }
      if (ids.direction === 'ledger_ahead') {
        // eslint-disable-next-line no-console
        console.warn(`[metabolism] ${ids.reason}`);
      }

      if (decision.kind === 'steady') {
        await writer.append({
          isSnapshot: true,
          prevState: state,
          newState: state,
          reason: decision.reason,
          idsMismatch,
          ...common,
        });
      } else if (decision.kind === 'transition') {
        let { keyId, keyHashPrefix } = common;
        if (decision.mint) {
          const p = await mint(decision.reason);
          keyId = p;
          keyHashPrefix = p;
        }
        checkAgainstStateMachine(decision.from, decision.event, decision.to);
        await writer.append({
          isSnapshot: false,
          prevState: decision.from,
          newState: decision.to,
          reason: decision.reason,
          idsMismatch,
          ...common,
          keyId,
          keyHashPrefix,
        });
        state = decision.to;
        await writer.append({
          isSnapshot: true,
          prevState: state,
          newState: state,
          reason: `snapshot after → ${state}`,
          idsMismatch,
          ...common,
          keyId,
          keyHashPrefix,
        });
      } else if (decision.kind === 'rotate') {
        checkAgainstStateMachine(decision.from, 'HYGIENE_DUE', 'ROTATING');
        await writer.append({
          isSnapshot: false,
          prevState: decision.from,
          newState: 'ROTATING',
          reason: decision.reason,
          idsMismatch,
          ...common,
        });
        const p = await mint(`hygiene rotation from ${decision.from}`);
        checkAgainstStateMachine('ROTATING', 'KEY_CLAIMED', 'ACTIVE');
        await writer.append({
          isSnapshot: false,
          prevState: 'ROTATING',
          newState: 'ACTIVE',
          reason: `rotated to ${p} (hygiene)`,
          idsMismatch,
          ...common,
          keyId: p,
          keyHashPrefix: p,
        });
        state = 'ACTIVE';
        await writer.append({
          isSnapshot: true,
          prevState: state,
          newState: state,
          reason: `snapshot after → ${state}`,
          idsMismatch,
          ...common,
          keyId: p,
          keyHashPrefix: p,
        });
      } else {
        // revoke: PHANTOM_SPEND (the compromise signal) or an unusable key (secret
        // not in the store — housekeeping, not a compromise). Only the former
        // marks the row so that a restart stays halted.
        const compromise = reading.phantomSpend === true;
        checkAgainstStateMachine(decision.from, compromise ? 'PHANTOM_SPEND' : 'IDS_MISMATCH', 'REVOKING');
        await writer.append({
          isSnapshot: false,
          prevState: decision.from,
          newState: 'REVOKING',
          reason: decision.reason,
          idsMismatch: compromise,
          ...common,
        });
        try {
          if (!c) throw new Error('revoking needs the MCP source (METABOLISM_SOURCE=mcp)');
          await orbioRevokeKey(c.client);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[metabolism] revoke_key failed', e instanceof Error ? e.message : e);
          await recordFailure('metabolism.revoke_key_failed', e);
        }
        updateOAuthBlob(storePath, encKey, {
          gatewayKey: null,
          gatewayKeyPrefix: null,
          spendBaseline: null,
        });
        checkAgainstStateMachine('REVOKING', 'REVOKED', 'NO_KEY');
        await writer.append({
          isSnapshot: false,
          prevState: 'REVOKING',
          newState: 'NO_KEY',
          reason: compromise
            ? 'revoked at provider after phantom spend — halting for manual re-auth (pnpm orbio:auth)'
            : 'revoked at provider — key was unusable; will remint next tick',
          idsMismatch: compromise,
          ...common,
          keyId: null,
          keyHashPrefix: null,
        });
        state = 'NO_KEY';
        halted = true;
        await writer.append({
          isSnapshot: true,
          prevState: state,
          newState: state,
          reason: 'snapshot after → NO_KEY (HALTED)',
          idsMismatch: true,
          ...common,
          keyId: null,
          keyHashPrefix: null,
        });
      }

      if (decision.kind !== 'steady') {
        const label =
          decision.kind === 'transition' ? `${decision.from} → ${decision.to}` : decision.kind.toUpperCase();
        // eslint-disable-next-line no-console
        console.log(`[metabolism] ${label}: ${decision.reason}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[metabolism] tick error', err instanceof Error ? err.message : err);
      await recordFailure('metabolism.tick_error', err);
      await dropConn();
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  await dropConn();
}
