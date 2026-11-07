-- Pill-supply tracking for medication reminders
ALTER TABLE "MedicationReminder"
  ADD COLUMN "pillsRemaining" INTEGER,
  ADD COLUMN "pillsPerDose" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "refillAlertDays" INTEGER NOT NULL DEFAULT 7;

-- Remembers whether a taken dose already used up its pills (so ticking twice or undoing is safe)
ALTER TABLE "ReminderDose"
  ADD COLUMN "pillsDeducted" BOOLEAN NOT NULL DEFAULT false;

-- Dose lookups are always "this reminder, this slot"
CREATE INDEX "ReminderDose_reminderId_scheduledAt_idx" ON "ReminderDose"("reminderId", "scheduledAt");

-- Tidy up: the old server pre-created "pending" dose rows at UTC clock times.
-- They carry no information (never taken, skipped or snoozed) and are re-created on demand.
DELETE FROM "ReminderDose"
WHERE "takenAt" IS NULL AND "skipped" = false AND "snoozedUntil" IS NULL;
