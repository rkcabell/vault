-- Tag Organizer: deterministic auto-tagging rules evaluated at ingest and by
-- the retroactive organize worker.
CREATE TYPE "TagRuleSource" AS ENUM ('MIME', 'EXTENSION', 'FILENAME', 'PATH_SEGMENT', 'FILE_DATE', 'SIZE');

CREATE TABLE "TagRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "TagRuleSource" NOT NULL,
    "matcher" JSONB NOT NULL DEFAULT '{}',
    "tagTemplate" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TagRule_userId_priority_idx" ON "TagRule"("userId", "priority");

ALTER TABLE "TagRule" ADD CONSTRAINT "TagRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the default rules for existing users (new users get the same set from
-- tagRuleRepository.seedDefaults at registration). Must stay in sync with
-- DEFAULT_TAG_RULES in apps/api/src/lib/tags/rules/defaults.ts.
INSERT INTO "TagRule" ("id", "userId", "name", "source", "matcher", "tagTemplate", "priority", "enabled", "updatedAt")
SELECT
    md5(u."id" || ':' || s."name" || ':' || random()::text),
    u."id",
    s."name",
    s."source"::"TagRuleSource",
    s."matcher"::jsonb,
    s."tagTemplate",
    s."priority",
    true,
    CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN (
    VALUES
        ('File type', 'MIME', '{}', 'type:{value}', 0),
        ('Year', 'FILE_DATE', '{"granularity": "year"}', 'year:{value}', 10),
        ('Month', 'FILE_DATE', '{"granularity": "month"}', 'month:{value}', 20),
        ('Folder', 'PATH_SEGMENT', '{}', 'folder:{value}', 30)
) AS s("name", "source", "matcher", "tagTemplate", "priority");
