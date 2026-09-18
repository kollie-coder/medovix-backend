/*
  Warnings:

  - You are about to drop the column `medovixVerified` on the `HospitalListing` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "HospitalListing" DROP COLUMN "medovixVerified",
ADD COLUMN     "medoviteVerified" BOOLEAN NOT NULL DEFAULT false;
