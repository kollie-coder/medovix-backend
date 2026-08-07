-- CreateTable
CREATE TABLE "NotificationPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allEnabled" BOOLEAN NOT NULL DEFAULT true,
    "doseReminders" BOOLEAN NOT NULL DEFAULT true,
    "missedDoseFollowup" BOOLEAN NOT NULL DEFAULT true,
    "refillAlerts" BOOLEAN NOT NULL DEFAULT true,
    "dailyHealthTips" BOOLEAN NOT NULL DEFAULT true,
    "mealLoggingReminders" BOOLEAN NOT NULL DEFAULT false,
    "appointmentReminders" BOOLEAN NOT NULL DEFAULT true,
    "careTeamMessages" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT NOT NULL DEFAULT '22:00',
    "quietHoursEnd" TEXT NOT NULL DEFAULT '07:00',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreferences_userId_key" ON "NotificationPreferences"("userId");

-- AddForeignKey
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
