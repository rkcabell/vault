/*
  Warnings:

  - You are about to drop the column `status` on the `Media` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MediaWorkerState" AS ENUM ('PENDING', 'READY', 'ERROR');

-- AlterTable
ALTER TABLE "Media" DROP COLUMN "status",
ADD COLUMN     "textState" "MediaWorkerState" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "thumbState" "MediaWorkerState" NOT NULL DEFAULT 'PENDING';

-- DropEnum
DROP TYPE "MediaStatus";
