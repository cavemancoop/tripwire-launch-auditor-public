# Where Tripwire is going

Tripwire begins with a narrow but important premise: a risk forecast should be committed before the outcome is known, and its eventual result should be independently checkable.

Today, Tripwire watches new Robinhood Chain launches, ranks defined failure modes, commits signed forecasts on-chain, and grades eligible forecasts in public. It is deployed now. The work below is planned, not presented as completed functionality.

## v0.3 — Follow a launch, not just its first ten minutes

A launch is not static. Tripwire will let someone follow a token and receive a new signed report when something material changes: a connected wallet moves, liquidity shifts, ownership changes, a vesting or unlock event approaches, or trading activity breaks from its prior pattern.

Each update will show what changed since the previous report, preserve the earlier report, and make the progression inspectable rather than overwriting history.

## v0.4 — Pre-trade context

The goal is a decision view that helps a person understand a launch before acting, without pretending to know the future.

Tripwire will place the current token beside comparable historical launches and show:

- the current risk ranking and the on-chain facts driving it;
- how those facts changed since the first report;
- comparable historical situations and their observed outcomes;
- which outcome signals are supported by evidence, weak, or not yet validated;
- a clear boundary between an evidence-backed ranking and an uncalibrated probability.

This is not financial advice or a promise of a winning trade. It is pre-trade context: a way to see the evidence, uncertainty, and audit trail before a decision.

## v0.5 — An open scoreboard for forecast systems

Tripwire’s commitment and grading system is designed to be model-agnostic. The long-term goal is to let other models, researchers, and forks submit forecasts to the same timing rules and be graded on the same public scoreboard.

That creates a market-like comparison layer without asking anyone to trust a private backtest: competing systems make commitments before outcomes, then accumulate a visible record of wins, misses, exclusions, calibration, and coverage.

## What must improve first

Before expanding product scope, Tripwire will make its operating evidence stronger:

1. Bound the scorer so full snapshots cannot exhaust worker memory.
2. Add independent heartbeat and memory monitoring.
3. Increase outcome-resolution throughput and reduce the grading backlog.
4. Expand coverage before making stronger performance claims.
5. Investigate failed cells without retroactively changing the frozen model against observed results.

The purpose of Tripwire is not to claim perfect prediction. It is to make on-chain research systems accountable enough that their performance can be checked, compared, and improved in public.
