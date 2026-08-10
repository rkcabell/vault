-- One-off reclassification. FAILED is terminal by design
-- (apps/api/src/lib/workerStateMachine.ts) and nothing else moves a row out of
-- it; this crosses that rule once, for rows that were only ever FAILED because
-- an unrenderable type reached the generic Sharp encode. Those rows are counted
-- by the library's "Thumbnail error" filter, which is what makes the wrong
-- state visible.
--
-- Scoped to mime types thumbnailSupported() rejects, so a genuine render
-- failure on an image, video or PDF keeps its FAILED state and its thumbError.

UPDATE "Media"
SET "thumbState" = 'UNSUPPORTED',
    "thumbError" = 'Unsupported file type for thumbnails'
WHERE "thumbState" = 'FAILED'
  AND lower("mimeType") NOT LIKE 'image/%'
  AND lower("mimeType") NOT LIKE 'video/%'
  AND lower("mimeType") NOT LIKE '%pdf%';
