-- AlterEnum
ALTER TYPE "MediaStatus" ADD VALUE 'PENDING_OCR';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "pages" JSONB;
