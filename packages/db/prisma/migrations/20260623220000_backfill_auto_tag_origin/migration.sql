-- Best-effort backfill: mark tags that the system generates (MIME-type/extension
-- labels from buildMimeTypeTag, plus the OCR/thumbnail system tags) as AUTO.
-- Bundle-name and arbitrary extension auto-tags can't be detected retroactively;
-- the "Mark as auto/user tag" control in tag settings covers the long tail.
UPDATE "Tag"
SET "origin" = 'AUTO'
WHERE "origin" = 'USER'
  AND "name" IN (
    'jpg', 'png', 'gif', 'webp', 'svg', 'tiff', 'bmp', 'heic', 'heif', 'avif',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'epub',
    'txt', 'csv', 'html', 'markdown',
    'mp4', 'webm', 'mov', 'mkv', 'avi',
    'mp3', 'wav', 'ogg', 'flac', 'aac',
    'zip', 'tar', 'gz', '7z', 'rar',
    'has-text', 'duplicate'
  );
