-- AlterTable
ALTER TABLE "lifecycle_log" ADD COLUMN     "bodyHash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- CreateTable
CREATE TABLE "metabolism_spend" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "model" TEXT NOT NULL,
    "keyHashPrefix" TEXT,
    "reportId" TEXT,
    "generationId" TEXT,

    CONSTRAINT "metabolism_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metabolism_spend_at_idx" ON "metabolism_spend"("at");
