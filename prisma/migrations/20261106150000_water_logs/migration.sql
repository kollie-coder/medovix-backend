-- CreateTable
CREATE TABLE "WaterLog" (
    "id" TEXT NOT NULL,
    "dietProfileId" TEXT NOT NULL,
    "amountMl" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaterLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaterLog_dietProfileId_date_idx" ON "WaterLog"("dietProfileId", "date");

-- AddForeignKey
ALTER TABLE "WaterLog" ADD CONSTRAINT "WaterLog_dietProfileId_fkey" FOREIGN KEY ("dietProfileId") REFERENCES "DietProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
