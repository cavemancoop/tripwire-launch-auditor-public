/**
 * Budget configuration. `RPC_BUDGET_RPM` (env) sets the sustained request rate
 * shared across every caller of a given RPC URL; default 500/min, comfortably
 * under ordofi's 600/min per-IP limit with headroom for retries.
 */
export interface BudgetConfig {
  rpm: number;
  maxInFlight: number;
  burst?: number;
}

let overrides: Partial<BudgetConfig> = {};

/** Test / boot hook to override the env-derived values. */
export function configureRpcBudget(cfg: Partial<BudgetConfig>): void {
  overrides = { ...overrides, ...cfg };
}

export function resolveBudgetConfig(): BudgetConfig {
  const envRpm = Number(process.env.RPC_BUDGET_RPM);
  const rpm = overrides.rpm ?? (Number.isFinite(envRpm) && envRpm > 0 ? envRpm : 500);
  const envInflight = Number(process.env.RPC_MAX_IN_FLIGHT);
  const maxInFlight =
    overrides.maxInFlight ?? (Number.isFinite(envInflight) && envInflight > 0 ? envInflight : 12);
  return { rpm, maxInFlight, burst: overrides.burst };
}
