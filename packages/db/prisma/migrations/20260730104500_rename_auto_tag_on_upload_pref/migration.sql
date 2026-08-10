-- Rename the preference key inside User.preferences (a JSON column, so this is
-- a data migration rather than a schema one): the Tag Organizer rules engine
-- runs at every ingest site — upload, in-place index, archive unpack — not just
-- upload.
--
-- Read paths also map the old key forward (normalizePreferenceKeys in
-- @vault/types), which is what covers a database restored from a pre-rename
-- dump. This statement is what stops the stale key from living in the blob
-- forever on installs that do run migrations.
-- jsonb_exists() rather than the `?` operator: `?` is a parameter placeholder to
-- enough SQL tooling that it is not worth the risk in a file that must apply
-- unchanged everywhere.
UPDATE "User"
SET "preferences" =
  CASE
    -- Both keys present: the current one already won at read time, so the
    -- legacy one is just dropped rather than clobbering it.
    WHEN jsonb_exists("preferences", 'autoTagOnIngest') THEN "preferences" - 'autoTagOnUpload'
    ELSE ("preferences" - 'autoTagOnUpload')
         || jsonb_build_object('autoTagOnIngest', "preferences" -> 'autoTagOnUpload')
  END
WHERE jsonb_exists("preferences", 'autoTagOnUpload');
