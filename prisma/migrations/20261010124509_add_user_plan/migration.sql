-- CreateEnum
CREATE TYPE "UserPlan" AS ENUM ('FREE', 'PREMIUM');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" "UserPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "planExpiresAt" TIMESTAMP(3);
