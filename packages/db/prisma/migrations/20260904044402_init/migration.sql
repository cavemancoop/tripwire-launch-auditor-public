-- CreateEnum
CREATE TYPE "LaunchSource" AS ENUM ('noxa', 'pons', 'raw');

-- CreateEnum
CREATE TYPE "Lane" AS ENUM ('index', 'qualified');

-- CreateEnum
CREATE TYPE "ReportTrigger" AS ENUM ('launch', 'qualified', 'on_demand', 'scheduled', 'event');

-- CreateEnum
CREATE TYPE "OutcomeLabel" AS ENUM ('INSIDER_EXIT', 'SELL_IMPAIRED', 'LIQ_IMPAIRED', 'DRAWDOWN_80');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('PENDING', 'RESOLVED', 'NA', 'UNRESOLVABLE');

-- CreateEnum
CREATE TYPE "ForecasterKind" AS ENUM ('base_rate', 'heuristic_v1', 'det_v0', 'det_v1', 'llm_deepdive_v0', 'scanhood', 'goplus');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('NO_KEY', 'ACTIVE', 'DRAINING', 'ROTATING', 'REVOKING', 'STARVED');

-- CreateEnum
CREATE TYPE "CommitKind" AS ENUM ('REPORT_BATCH', 'ARTIFACT', 'SIGNER_ROTATION');

-- CreateTable
CREATE TABLE "launches" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "source" "LaunchSource" NOT NULL,
    "lpLockedByConstruction" BOOLEAN NOT NULL DEFAULT false,
    "tokenAddress" TEXT NOT NULL,
    "poolAddress" TEXT,
    "creatorAddress" TEXT NOT NULL,
    "launchBlock" BIGINT NOT NULL,
    "launchTxHash" TEXT NOT NULL,
    "launchAt" TIMESTAMP(3),
    "lane" "Lane" NOT NULL DEFAULT 'index',
    "quotaExceeded" BOOLEAN NOT NULL DEFAULT false,
    "retrospective" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "features" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'v0',
    "creatorDevbuyPct" DOUBLE PRECISION,
    "creatorAgeDays" DOUBLE PRECISION,
    "creatorPriorLaunches" INTEGER,
    "creatorPriorInsiderExitRate" DOUBLE PRECISION,
    "clusterSize" INTEGER,
    "clusterSupplyPct" DOUBLE PRECISION,
    "top10NoncreatorPct" DOUBLE PRECISION,
    "uniqueBuyers10m" INTEGER,
    "buysPerBuyer10m" DOUBLE PRECISION,
    "microbuyShare10m" DOUBLE PRECISION,
    "liquidityUsd10m" DOUBLE PRECISION,
    "sellImpactBps" INTEGER,
    "hasX" BOOLEAN,
    "hasSite" BOOLEAN,
    "verified" BOOLEAN,
    "ownerRenounced" BOOLEAN,
    "mintable" BOOLEAN,
    "lpHolderType" TEXT,
    "sellSimOk" BOOLEAN,
    "sellTaxBps" INTEGER,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "goplusRaw" JSONB,
    "goplusFetchedAt" TIMESTAMP(3),
    "scanhoodRaw" JSONB,
    "scanhoodFetchedAt" TIMESTAMP(3),
    "indexLaneComputedAt" TIMESTAMP(3),
    "t10ComputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "reportTime" TIMESTAMP(3) NOT NULL,
    "trigger" "ReportTrigger" NOT NULL,
    "forecaster" "ForecasterKind" NOT NULL,
    "forecasterVersion" TEXT NOT NULL,
    "launchId" TEXT,
    "ageHours" DOUBLE PRECISION,
    "holderCountTrend" DOUBLE PRECISION,
    "clusterBalanceDeltaPct" DOUBLE PRECISION,
    "liquidityDeltaPct" DOUBLE PRECISION,
    "ownershipChangedSinceLast" BOOLEAN,
    "implementationChangedSinceLast" BOOLEAN,
    "pInsiderExit6h" DOUBLE PRECISION,
    "pInsiderExit24h" DOUBLE PRECISION,
    "pInsiderExit72h" DOUBLE PRECISION,
    "pSellImpaired1h" DOUBLE PRECISION,
    "pSellImpaired24h" DOUBLE PRECISION,
    "pLiqImpaired24h" DOUBLE PRECISION,
    "pLiqImpaired7d" DOUBLE PRECISION,
    "pDrawdown80_24h" DOUBLE PRECISION,
    "pDrawdown80_7d" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "evidence" JSONB,
    "canonicalJson" TEXT NOT NULL,
    "reportHash" TEXT NOT NULL,
    "eip712Signature" TEXT,
    "signerAddress" TEXT,
    "createdAtBlock" BIGINT,
    "retrospective" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commitId" TEXT,
    "merkleLeafHash" TEXT,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" TEXT NOT NULL,
    "kind" "CommitKind" NOT NULL,
    "chainId" INTEGER NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "leafCount" INTEGER NOT NULL DEFAULT 0,
    "leaves" JSONB NOT NULL DEFAULT '[]',
    "featureCodeHash" TEXT,
    "weightHash" TEXT,
    "outcomeRuleHash" TEXT,
    "scorerHash" TEXT,
    "modelId" TEXT,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "anchorTime" TIMESTAMP(3) NOT NULL,
    "trigger" "ReportTrigger" NOT NULL,
    "launchId" TEXT,
    "label" "OutcomeLabel" NOT NULL,
    "horizon" TEXT NOT NULL,
    "status" "OutcomeStatus" NOT NULL DEFAULT 'PENDING',
    "value" BOOLEAN,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v1',
    "evidence" JSONB,
    "horizonAt" TIMESTAMP(3),
    "measuredAt" TIMESTAMP(3),
    "retrospective" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_log" (
    "id" TEXT NOT NULL,
    "isSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "prevState" "LifecycleState",
    "newState" "LifecycleState" NOT NULL,
    "reason" TEXT NOT NULL,
    "keyId" TEXT,
    "keyHashPrefix" TEXT,
    "balanceUsd" DOUBLE PRECISION,
    "keyRemainingUsd" DOUBLE PRECISION,
    "reserveUsd" DOUBLE PRECISION,
    "ledgerSpendUsd" DOUBLE PRECISION,
    "providerSpendUsd" DOUBLE PRECISION,
    "idsMismatch" BOOLEAN NOT NULL DEFAULT false,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lifecycle_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "payerAddress" TEXT,
    "asset" TEXT NOT NULL DEFAULT 'USDG',
    "amount" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT,
    "apiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "launches_source_launchBlock_idx" ON "launches"("source", "launchBlock");

-- CreateIndex
CREATE INDEX "launches_creatorAddress_idx" ON "launches"("creatorAddress");

-- CreateIndex
CREATE INDEX "launches_lane_createdAt_idx" ON "launches"("lane", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "launches_chainId_tokenAddress_key" ON "launches"("chainId", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "features_launchId_key" ON "features"("launchId");

-- CreateIndex
CREATE UNIQUE INDEX "reports_reportHash_key" ON "reports"("reportHash");

-- CreateIndex
CREATE INDEX "reports_chainId_tokenAddress_reportTime_idx" ON "reports"("chainId", "tokenAddress", "reportTime");

-- CreateIndex
CREATE INDEX "reports_launchId_forecaster_idx" ON "reports"("launchId", "forecaster");

-- CreateIndex
CREATE INDEX "reports_forecaster_trigger_createdAt_idx" ON "reports"("forecaster", "trigger", "createdAt");

-- CreateIndex
CREATE INDEX "reports_commitId_idx" ON "reports"("commitId");

-- CreateIndex
CREATE INDEX "commits_kind_createdAt_idx" ON "commits"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "commits_txHash_idx" ON "commits"("txHash");

-- CreateIndex
CREATE INDEX "outcomes_status_horizonAt_idx" ON "outcomes"("status", "horizonAt");

-- CreateIndex
CREATE INDEX "outcomes_trigger_idx" ON "outcomes"("trigger");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_chainId_tokenAddress_anchorTime_label_horizon_rule_key" ON "outcomes"("chainId", "tokenAddress", "anchorTime", "label", "horizon", "ruleVersion");

-- CreateIndex
CREATE INDEX "lifecycle_log_createdAt_idx" ON "lifecycle_log"("createdAt");

-- CreateIndex
CREATE INDEX "lifecycle_log_newState_createdAt_idx" ON "lifecycle_log"("newState", "createdAt");

-- CreateIndex
CREATE INDEX "receipts_endpoint_createdAt_idx" ON "receipts"("endpoint", "createdAt");

-- CreateIndex
CREATE INDEX "receipts_txHash_idx" ON "receipts"("txHash");

-- AddForeignKey
ALTER TABLE "features" ADD CONSTRAINT "features_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_commitId_fkey" FOREIGN KEY ("commitId") REFERENCES "commits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
