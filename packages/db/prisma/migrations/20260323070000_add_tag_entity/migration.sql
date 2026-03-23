-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: compound unique on (userId, name)
CREATE UNIQUE INDEX "Tag_userId_name_key" ON "Tag"("userId", "name");

-- CreateIndex: for fast top-tags queries ordered by count desc
CREATE INDEX "Tag_userId_count_idx" ON "Tag"("userId", "count" DESC);

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Populate Tag table from existing Media.tags.
-- Uses md5(userId || ':' || name) as a deterministic TEXT id so re-running is safe.
-- ON CONFLICT refreshes counts in case the migration is applied more than once.
INSERT INTO "Tag" ("id", "userId", "name", "count", "createdAt")
SELECT
    md5("userId" || ':' || lower(tag)) AS id,
    "userId",
    lower(tag) AS name,
    COUNT(*)::int AS count,
    now() AS "createdAt"
FROM (
    SELECT "userId", unnest("tags") AS tag
    FROM "Media"
) t
WHERE lower(tag) <> ''
GROUP BY "userId", lower(tag)
ON CONFLICT ("userId", "name") DO UPDATE SET "count" = EXCLUDED."count";
