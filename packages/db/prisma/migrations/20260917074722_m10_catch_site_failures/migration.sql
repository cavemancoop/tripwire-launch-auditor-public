-- CreateTable
CREATE TABLE "catch_site_failures" (
    "site" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastMessage" TEXT,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catch_site_failures_pkey" PRIMARY KEY ("site")
);
