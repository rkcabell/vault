-- Media starring (mirrors Bundle.starred / starredAt).
ALTER TABLE "Media" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Media" ADD COLUMN "starredAt" TIMESTAMP(3);
