/*
  Warnings:

  - You are about to alter the column `totalAmount` on the `Bill` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - You are about to alter the column `amountPaid` on the `Bill` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - You are about to alter the column `unitPrice` on the `BillItem` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - You are about to alter the column `total` on the `BillItem` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - You are about to alter the column `amount` on the `Payment` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.
  - A unique constraint covering the columns `[reversesId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REVERSAL');

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "createdById" TEXT,
ALTER COLUMN "totalAmount" SET DATA TYPE INTEGER,
ALTER COLUMN "amountPaid" SET DEFAULT 0,
ALTER COLUMN "amountPaid" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "BillItem" ALTER COLUMN "unitPrice" SET DATA TYPE INTEGER,
ALTER COLUMN "total" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "reversesId" TEXT,
ALTER COLUMN "amount" SET DATA TYPE INTEGER;

-- CreateTable
CREATE TABLE "PriceItem" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "type" "BillItemType" NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceItem_hospitalId_type_idx" ON "PriceItem"("hospitalId", "type");

-- CreateIndex
CREATE INDEX "Bill_appointmentId_idx" ON "Bill"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesId_key" ON "Payment"("reversesId");

-- CreateIndex
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceItem" ADD CONSTRAINT "PriceItem_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
