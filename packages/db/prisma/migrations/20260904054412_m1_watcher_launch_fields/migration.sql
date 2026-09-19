/*
  Warnings:

  - The `source` column on the `launches` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "launches" ADD COLUMN     "detectedVia" TEXT,
ADD COLUMN     "poolId" TEXT,
ADD COLUMN     "poolKind" TEXT,
ADD COLUMN     "sourceConfidence" DOUBLE PRECISION,
DROP COLUMN "source",
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'unknown';

-- DropEnum
DROP TYPE "LaunchSource";

-- CreateTable
CREATE TABLE "watcher_cursors" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watcher_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "watcher_cursors_chainId_stream_key" ON "watcher_cursors"("chainId", "stream");

-- CreateIndex
CREATE INDEX "launches_source_launchBlock_idx" ON "launches"("source", "launchBlock");

-- CreateIndex
CREATE INDEX "launches_poolAddress_idx" ON "launches"("poolAddress");

-- CreateIndex
CREATE INDEX "launches_poolId_idx" ON "launches"("poolId");
