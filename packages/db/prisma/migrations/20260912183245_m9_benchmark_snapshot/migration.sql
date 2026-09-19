-- CreateTable
CREATE TABLE "benchmark_snapshots" (
    "key" TEXT NOT NULL DEFAULT 'latest',
    "json" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benchmark_snapshots_pkey" PRIMARY KEY ("key")
);
