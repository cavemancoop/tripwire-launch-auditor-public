-- AlterTable
ALTER TABLE "launches" ADD COLUMN     "poolFeeSuspect" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "primaryPoolCheckedAt" TIMESTAMP(3);
