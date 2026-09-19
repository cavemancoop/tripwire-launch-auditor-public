-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "blockPin" JSONB,
ADD COLUMN     "coverage" JSONB,
ADD COLUMN     "validatorFailures" JSONB,
ADD COLUMN     "validatorPassed" BOOLEAN NOT NULL DEFAULT false;
