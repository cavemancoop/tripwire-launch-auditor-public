-- AlterTable
ALTER TABLE "features" ADD COLUMN     "sellImpactBps100" INTEGER,
ADD COLUMN     "sellImpactBps1000" INTEGER;

-- AlterTable
ALTER TABLE "launches" ADD COLUMN     "tokenAgeAtPoolSec" INTEGER;
