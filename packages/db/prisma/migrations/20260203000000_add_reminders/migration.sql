-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELED');

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "mediaId" TEXT,
    "status" "ReminderStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "snoozedUntil" TIMESTAMP(3),
    "remindOffsetDays" INTEGER,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "rrule" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_userId_status_remindAt_idx" ON "Reminder"("userId", "status", "remindAt");

-- CreateIndex
CREATE INDEX "Reminder_userId_status_dueAt_idx" ON "Reminder"("userId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Reminder_userId_status_nextDueAt_idx" ON "Reminder"("userId", "status", "nextDueAt");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add check constraint for recurrence invariants
ALTER TABLE "Reminder"
ADD CONSTRAINT "Reminder_rrule_nextDueAt_check"
CHECK (
  ("rrule" IS NULL AND "nextDueAt" IS NULL) OR
  ("rrule" IS NOT NULL AND "nextDueAt" IS NOT NULL)
);
