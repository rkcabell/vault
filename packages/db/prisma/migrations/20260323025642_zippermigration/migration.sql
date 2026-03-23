-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "sourceMediaId" TEXT;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "linkedBundleId" TEXT;
