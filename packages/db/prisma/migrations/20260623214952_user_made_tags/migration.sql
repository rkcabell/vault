-- CreateEnum
CREATE TYPE "TagOrigin" AS ENUM ('USER', 'AUTO');

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "origin" "TagOrigin" NOT NULL DEFAULT 'USER';
