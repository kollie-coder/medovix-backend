-- CreateTable
CREATE TABLE "StaffMessage" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "replyToId" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffMessage_recipientId_readAt_idx" ON "StaffMessage"("recipientId", "readAt");

-- CreateIndex
CREATE INDEX "StaffMessage_recipientId_createdAt_idx" ON "StaffMessage"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffMessage_senderId_createdAt_idx" ON "StaffMessage"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffMessage_appointmentId_idx" ON "StaffMessage"("appointmentId");

-- CreateIndex
CREATE INDEX "StaffMessage_hospitalId_idx" ON "StaffMessage"("hospitalId");

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
