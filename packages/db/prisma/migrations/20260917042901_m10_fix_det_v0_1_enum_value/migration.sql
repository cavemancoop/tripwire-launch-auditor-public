-- Fixes the previous migration: Prisma Client validates enum arguments
-- against the schema-declared identifier, not the `@map`-ped DB value, so
-- `@map("det_v0.1")` made every det_v0.1 report write fail client-side with
-- "Invalid value for argument `forecaster`. Expected ForecasterKind." before
-- it ever reached Postgres -- nothing was persisted with the old value.
-- AlterEnum
ALTER TYPE "ForecasterKind" RENAME VALUE 'det_v0.1' TO 'det_v0_1';
