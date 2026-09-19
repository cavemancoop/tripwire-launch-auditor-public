# Tripwire in three minutes

Tripwire's job is not to predict every token perfectly. Its job is to publish a testable risk ranking early enough that it can later be judged fairly.

1. Open the [dashboard](https://web-production-ddcf3.up.railway.app) and start with **One forecast, checked end to end**. It shows a completed forecast, its chain commitment, and its observed outcome.
2. Run the receipt verifier from the README. It recomputes the report hash, recovers the EIP-712 signer, folds the Merkle proof, and checks the actual commit transaction and block timestamp.
3. Open the [benchmark](https://api-production-6a84.up.railway.app/v1/benchmark). Its `live` section contains only timing-eligible, non-retrospective rows. The `exclusions` field shows the records deliberately left out.
4. Read the coverage policy. It states which outcomes are unresolved and why the graded rows are not a random sample.
5. Return to the dashboard's budget and funding panel. It shows the Orbio/CREDIT mechanism that constrains optional deep-dive compute.

The intended takeaway is simple: an automated system made a signed, on-chain commitment; its timing can be checked independently; and its performance table includes both its stronger and weaker results.

## Product boundaries

- Rankings are not calibrated probabilities or investment advice.
- A commitment demonstrates timing and integrity, not correctness.
- The operator funds the deployed instance; CREDIT supports its compute budget.
- The outcome resolver has a backlog, which the benchmark exposes rather than treating as complete coverage.
