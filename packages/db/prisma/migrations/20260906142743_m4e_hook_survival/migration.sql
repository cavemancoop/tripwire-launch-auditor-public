-- AlterEnum
ALTER TYPE "OutcomeLabel" ADD VALUE 'TRADING_ALIVE';

-- AlterTable
ALTER TABLE "features" ADD COLUMN     "creatorApprovalsOutsideRouters" INTEGER,
ADD COLUMN     "hookCanBlockSwap" BOOLEAN,
ADD COLUMN     "hookCanTaxSwap" BOOLEAN,
ADD COLUMN     "hookGatesLpRemoval" BOOLEAN,
ADD COLUMN     "hookPermissions" INTEGER,
ADD COLUMN     "sidePoolCount" INTEGER;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "pTradingAlive24h" DOUBLE PRECISION,
ADD COLUMN     "pTradingAlive7d" DOUBLE PRECISION;
