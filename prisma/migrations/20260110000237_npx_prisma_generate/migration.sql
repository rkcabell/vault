-- CreateEnum
CREATE TYPE "TextSource" AS ENUM ('OCR', 'NATIVE');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "textSource" "TextSource";
