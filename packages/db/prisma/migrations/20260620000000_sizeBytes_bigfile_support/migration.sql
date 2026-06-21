-- AlterTable: change sizeBytes from INT4 to DOUBLE PRECISION so files larger
-- than ~2.1 GB (the INT4 max) can be indexed in place. Postgres casts INT→FLOAT8
-- without data loss since all existing values fit in a 64-bit float exactly.
ALTER TABLE "Media" ALTER COLUMN "sizeBytes" TYPE DOUBLE PRECISION;
