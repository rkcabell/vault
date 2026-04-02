-- Add tsvector column for full-text search
ALTER TABLE "Document" ADD COLUMN "searchVector" tsvector;

-- GIN index for fast full-text search (must be created via raw SQL; Prisma does not support tsvector natively)
CREATE INDEX "document_search_vector_gin" ON "Document" USING gin("searchVector");

-- Backfill existing rows using 'simple' dictionary (no stemming, correct for non-English OCR output)
UPDATE "Document" SET "searchVector" = to_tsvector('simple', "rawText") WHERE "rawText" IS NOT NULL;
