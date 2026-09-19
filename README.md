# Tripwire Launch Auditor

**Signed, time-bounded risk rankings for new Robinhood Chain token launches.**

Tripwire watches new liquidity pools on Robinhood Chain (chain 4663). Ten minutes after a launch, it derives deterministic on-chain signals, signs a forecast, and commits its hash on-chain. It later grades those rankings against mechanically defined outcomes and public baselines.

The project is designed to make one important question easy to answer: *did this forecast exist before the outcome was known?*

## Live links

- Dashboard: <https://web-production-ddcf3.up.railway.app>
- Public API: <https://api-production-6a84.up.railway.app>
- Benchmark: <https://api-production-6a84.up.railway.app/v1/benchmark>

## What Tripwire does

```text
New pool appears -> wait 10 minutes -> derive on-chain features
       -> sign + commit forecast hash -> resolve outcomes -> score eligible rows
```

It currently ranks launch risk for insider exit, sell impairment, liquidity impairment, severe drawdown, and continued trading. The dashboard deliberately shows both useful cells and cells where the model ranks backwards.

## The integrity rule

A score can count in the benchmark only when its commit transaction landed on chain within 30 minutes of the report's T+10-minute anchor and before that outcome's horizon ended. Replays, late commits, uncommitted reports, and records whose block time cannot be read are excluded and counted separately.

This rule exists because an outage replay can create a valid signature and a valid on-chain commitment after part of the outcome is already observable. A valid hash is not enough; the timing must be verifiable too.

## Verify one forecast

The public receipt supplies the exact canonical report bytes, EIP-712 signature, Merkle proof, commit transaction, and outcome eligibility. The verifier rebuilds each link locally and reads the transaction receipt and block time from a public RPC.

```bash
pnpm install
pnpm verify:receipt 0xbe1e685a69a34249a45bed2a31bda873c0765cf32abb8a41ab906ec768c7e915
```

The sample is an eligible, completed insider-exit forecast. See [docs/VERIFICATION.md](./docs/VERIFICATION.md) for what the command checks.

## What the benchmark says

The scores are **rankings, not calibrated probabilities**. They are not an investment recommendation.

The live benchmark currently shows that the deterministic model beats both published base rates on some eligible insider-exit and continued-trading cells. It also shows cells where it ranks outcomes backwards, and it does not claim the LLM deep-dive adds discrimination. The resolver backlog means resolved outcomes are not a random sample; the API publishes that limitation alongside coverage.

## Orbio / CREDIT

The optional deep-dive worker uses an Orbio gateway key. Its daily compute budget is capped by the smaller of the configured limit, half of CREDIT activated into the agent account in the previous 24 hours, and the spendable balance after its reserve. The public dashboard shows the live gate and public activation records.

The operator funds the instance. Tripwire does not claim to pay for itself.

## Run locally

Requirements: Node 22+, pnpm 11, and Docker Desktop for Postgres and Redis.

```bash
pnpm install
cp .env.example .env
pnpm verify
docker compose up -d
pnpm db:migrate
pnpm start
```

Open `http://localhost:3002` after the services start. A real worker also needs the chain RPC, signing wallet, registry address, and any optional Orbio settings described in `.env.example`. Never commit `.env`, token stores, or private keys.

## Repository map

```text
apps/api       Public API, receipts, proof verification, dashboard data
apps/worker    Watcher, report assembler, commits, outcome resolver, scorer
apps/web       Dependency-free public dashboard
packages/chain Robinhood Chain readers and pool decoders
packages/db    Prisma schema, lifecycle chain, shared budget gate
packages/scoring Eligibility rule, metrics, baselines, comparison gates
packages/contracts CommitRegistry Solidity contract and tests
```

## Judge path

Read [docs/JUDGE-GUIDE.md](./docs/JUDGE-GUIDE.md) for the three-minute product walkthrough. The guide leads with a receipt, then the eligible benchmark, then the CREDIT-funded compute mechanism.

## Security

Please do not open an issue containing a secret, wallet key, access token, or production credential. See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
