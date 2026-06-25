-- Backfill existing rows onto the new UNSUPPORTED state (added in the preceding
-- migration). See 20260624000000_add_unsupported_worker_state.

-- Thumbnails: FAILED was used for BOTH real render failures and the two skip cases
-- (unsupported type / too large), distinguished only by a sentinel string in
-- thumbError. Migrate just the two skip-sentinels; genuine render failures stay FAILED.
UPDATE "Media"
SET "thumbState" = 'UNSUPPORTED'
WHERE "thumbState" = 'FAILED'
  AND "thumbError" IN (
    'Unsupported file type for thumbnails',
    'File too large for thumbnail (over 2 GB)'
  );

-- Text: FAILED was ONLY ever used for unsupported-type / too-large skips (real text
-- failures use ERROR), so every text FAILED row migrates to UNSUPPORTED.
UPDATE "Media"
SET "textState" = 'UNSUPPORTED'
WHERE "textState" = 'FAILED';
