-- M11a: base_rate_fixed added to the forecaster roster (spec §2). Never
-- written to reports.forecaster (it is computed at scoring time, like
-- base_rate/scanhood/goplus already in this enum) -- documentation-only,
-- no data migration needed.
ALTER TYPE "ForecasterKind" ADD VALUE 'base_rate_fixed';
