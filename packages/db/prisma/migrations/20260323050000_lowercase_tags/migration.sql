-- Normalize all existing tags to lowercase and deduplicate.
-- e.g. ['Photo', 'photo', 'IMAGE'] → ['photo', 'image']
UPDATE "Media"
SET "tags" = ARRAY(
  SELECT DISTINCT lower(t)
  FROM unnest("tags") AS t
  WHERE t IS NOT NULL AND lower(t) <> ''
)
WHERE EXISTS (
  SELECT 1 FROM unnest("tags") AS t WHERE t <> lower(t)
);
