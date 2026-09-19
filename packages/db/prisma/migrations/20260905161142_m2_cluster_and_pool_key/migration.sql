-- CreateEnum
CREATE TYPE "ClusterRule" AS ENUM ('CREATOR', 'LAUNCH_BLOCK_BUY', 'DIRECT_TRANSFER', 'FIRST_INBOUND');

-- AlterTable
ALTER TABLE "features" ADD COLUMN     "clusterConfidence" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "launches" ADD COLUMN     "poolFee" INTEGER,
ADD COLUMN     "poolHooks" TEXT,
ADD COLUMN     "poolTickSpacing" INTEGER;

-- CreateTable
CREATE TABLE "creator_cluster" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "rule" "ClusterRule" NOT NULL,
    "evidenceTx" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_cluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_cluster_launchId_idx" ON "creator_cluster"("launchId");

-- CreateIndex
CREATE INDEX "creator_cluster_address_idx" ON "creator_cluster"("address");

-- CreateIndex
CREATE UNIQUE INDEX "creator_cluster_launchId_address_rule_key" ON "creator_cluster"("launchId", "address", "rule");

-- AddForeignKey
ALTER TABLE "creator_cluster" ADD CONSTRAINT "creator_cluster_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
