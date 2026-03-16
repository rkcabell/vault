-- CreateTable
CREATE TABLE "MediaExtractedMetadata" (
    "mediaId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaExtractedMetadata_pkey" PRIMARY KEY ("mediaId")
);

-- AddForeignKey
ALTER TABLE "MediaExtractedMetadata" ADD CONSTRAINT "MediaExtractedMetadata_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
