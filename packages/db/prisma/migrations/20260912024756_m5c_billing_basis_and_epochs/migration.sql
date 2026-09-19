-- AlterTable
ALTER TABLE "lifecycle_log" ADD COLUMN     "billingStatus" TEXT;

-- AlterTable
ALTER TABLE "metabolism_spend" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "costBasis" TEXT NOT NULL DEFAULT 'unavailable',
ADD COLUMN     "epochId" TEXT,
ADD COLUMN     "estimatedCostUsd" DOUBLE PRECISION,
ADD COLUMN     "pricingVersion" TEXT,
ADD COLUMN     "promptTokens" INTEGER,
ADD COLUMN     "reconciledCostUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "metabolism_epoch" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyHashPrefix" TEXT,
    "providerSpendUsd" DOUBLE PRECISION NOT NULL,
    "providerDeltaUsd" DOUBLE PRECISION NOT NULL,
    "localEstimateUsd" DOUBLE PRECISION NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "reconciliationFactor" DOUBLE PRECISION,
    "discrepancyPct" DOUBLE PRECISION,
    "anomaly" BOOLEAN NOT NULL DEFAULT false,
    "phantom" BOOLEAN NOT NULL DEFAULT false,
    "billingStatus" TEXT NOT NULL,

    CONSTRAINT "metabolism_epoch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metabolism_epoch_at_idx" ON "metabolism_epoch"("at");

-- CreateIndex
CREATE INDEX "metabolism_spend_epochId_idx" ON "metabolism_spend"("epochId");
