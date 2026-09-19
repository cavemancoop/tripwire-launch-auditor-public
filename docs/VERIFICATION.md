# Verifying a Tripwire receipt

Use the verifier from the repository root:

```bash
pnpm verify:receipt <report-hash>
```

It fetches `GET /v1/receipt/<report-hash>` by default. You can point it to a different API, RPC, signer, registry, or a saved JSON file with `--api`, `--rpc`, `--signer`, `--registry`, and `--file`.

The verifier checks:

1. `keccak256(canonicalJson)` equals the report hash.
2. The EIP-712 signature recovers the published report signer using the canonical report fields, not server-supplied display fields.
3. The Merkle proof folds from that hash to the published root.
4. The claimed transaction succeeded, occurred in the claimed block, and emitted the root from the CommitRegistry.
5. The commit block's timestamp yields the published eligibility class for each outcome.

The receipt API is a source of bytes. The verifier recomputes the conclusion.
