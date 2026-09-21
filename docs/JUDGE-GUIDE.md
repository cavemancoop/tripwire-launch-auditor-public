# Tripwire in three minutes

Tripwire's job is not to predict every token perfectly. Its job is to publish a testable risk ranking early enough that it can later be judged fairly.

1. Open the [dashboard](https://web-production-ddcf3.up.railway.app) and start with **One forecast, checked end to end**. It shows a completed forecast, its chain commitment, and its observed outcome.
2. Run the receipt verifier from the README. It recomputes the report hash, recovers the EIP-712 signer, folds the Merkle proof, and checks the actual commit transaction and block timestamp.
3. Scroll to the dashboard's **Benchmark** panel (04). It lists every outcome, horizon and forecaster, and it shows both the stronger result (insider exit at 24h) and the weaker one (the 80% drawdown cell, where `det_v0` ranks backwards and an existing scanner beats it). Only timing-eligible, non-retrospective rows are scored; the excluded records are counted under each outcome. The same data is available as JSON at `/v1/benchmark` on the API host if you want to check it programmatically — it is a large raw document, not a page to read.
4. Read the coverage line above that table. It states how many outcomes have been graded out of those whose horizon has passed, and why the graded rows are not a random sample.
5. Return to the dashboard's **Metabolism** panel (01) for the Orbio/CREDIT mechanism that bounds deep-dive compute, and the **Key lifecycle** panel (05) for the signed, hash-chained continuity log.

The intended takeaway is simple: an automated system made a signed, on-chain commitment; its timing can be checked independently; and its performance table includes both its stronger and weaker results.

## Product boundaries

- Rankings are not calibrated probabilities or investment advice.
- A commitment demonstrates timing and integrity, not correctness.
- The operator funds the deployed instance; CREDIT supports its compute budget.
- The outcome resolver has a backlog, which the benchmark exposes rather than treating as complete coverage.
