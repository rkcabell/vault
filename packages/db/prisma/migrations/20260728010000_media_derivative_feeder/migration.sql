-- Make the database the derivative backlog instead of Redis.
--
-- Indexing used to push a thumb and a text job per discovered file the moment
-- the row was written. On a ~190k-file library that means Redis holding tens of
-- thousands of jobs the workers cannot drain for days, no way to reprioritise
-- them once queued, and a cancel that has to delete them one by one.
--
-- Under the pull model the row itself is the backlog: indexing writes it at
-- PENDING and enqueues nothing, and a feeder tops each queue up from here
-- between a low and a high water mark. Redis then only ever holds the working
-- set.
--
-- These columns record when a row was last handed to a queue. NULL = never
-- dispatched, i.e. still waiting in the backlog. Two behaviours hang off that:
--
--   1. The feeder claims only NULL rows, so the stamp is what keeps it from
--      re-dispatching work that is already in flight.
--   2. Stall detection now keys on these instead of `updatedAt`. A row that was
--      never dispatched cannot have stalled — and the old `updatedAt` clock
--      would have marked the entire un-fed backlog FAILED/ERROR fifteen minutes
--      into the first index. (`updatedAt` was also wrong for an unrelated
--      reason: retagging an item reset its stall clock.)
--
-- Both columns are nullable with no default, so existing rows read as "never
-- dispatched" and get picked up by the feeder on its next tick. Any job those
-- rows already have in Redis is deduplicated by jobId, so the overlap during a
-- deploy is a no-op rather than double work.
ALTER TABLE "Media" ADD COLUMN "thumbQueuedAt" TIMESTAMP(3);
ALTER TABLE "Media" ADD COLUMN "textQueuedAt" TIMESTAMP(3);

-- The feeder's claim runs every tick and stall detection sweeps on an interval;
-- both filter on the state first and the stamp second. Without these the claim
-- is a sequential scan of the whole table, which is precisely how a feeder
-- becomes its own bottleneck.
CREATE INDEX "Media_thumbState_thumbQueuedAt_idx" ON "Media"("thumbState", "thumbQueuedAt");
CREATE INDEX "Media_textState_textQueuedAt_idx" ON "Media"("textState", "textQueuedAt");
