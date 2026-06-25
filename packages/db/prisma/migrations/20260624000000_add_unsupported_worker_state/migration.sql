-- Add a first-class UNSUPPORTED state to MediaWorkerState. Until now FAILED was
-- overloaded to mean both "the worker tried and failed" and "this file was never
-- processable" (wrong type, or too large to load into memory). UNSUPPORTED carries
-- the latter meaning so FAILED (thumbnails) / ERROR (text) mean only real failures.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to commit before the new value can be
-- USED in a later statement, so the backfill that references 'UNSUPPORTED' lives in a
-- separate migration (20260624000100_backfill_unsupported_state).
ALTER TYPE "MediaWorkerState" ADD VALUE 'UNSUPPORTED';
