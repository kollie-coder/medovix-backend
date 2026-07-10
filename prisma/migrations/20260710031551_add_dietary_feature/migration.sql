-- CreateEnum
CREATE TYPE "ActivityLevel" AS ENUM ('SEDENTARY', 'LIGHT', 'MODERATE', 'ACTIVE', 'VERY_ACTIVE');

-- CreateEnum
CREATE TYPE "HealthCondition" AS ENUM ('GENERAL_WELLNESS', 'TYPE2_DIABETES', 'HYPERTENSION', 'HEART_DISEASE', 'WEIGHT_LOSS', 'PREGNANCY', 'OSTEOPOROSIS', 'LACTOSE_INTOLERANCE');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'DIETICIAN';

-- CreateTable
CREATE TABLE "DietProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "condition" "HealthCondition" NOT NULL DEFAULT 'GENERAL_WELLNESS',
    "age" INTEGER,
    "weight" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "activityLevel" "ActivityLevel" NOT NULL DEFAULT 'MODERATE',
    "dailyCalories" INTEGER NOT NULL DEFAULT 2000,
    "dailyCarbs" INTEGER NOT NULL DEFAULT 250,
    "dailyProtein" INTEGER NOT NULL DEFAULT 50,
    "dailyFat" INTEGER NOT NULL DEFAULT 65,
    "dailyWater" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DietProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'international',
    "calories" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "fibre" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sodium" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sugar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "suitableFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoidFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodLog" (
    "id" TEXT NOT NULL,
    "dietProfileId" TEXT NOT NULL,
    "foodItemId" TEXT NOT NULL,
    "mealType" "MealType" NOT NULL,
    "portionGrams" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "calories" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TEXT NOT NULL,

    CONSTRAINT "FoodLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DietProfile_userId_key" ON "DietProfile"("userId");

-- CreateIndex
CREATE INDEX "FoodItem_category_idx" ON "FoodItem"("category");

-- CreateIndex
CREATE INDEX "FoodItem_origin_idx" ON "FoodItem"("origin");

-- CreateIndex
CREATE INDEX "FoodLog_dietProfileId_idx" ON "FoodLog"("dietProfileId");

-- CreateIndex
CREATE INDEX "FoodLog_date_idx" ON "FoodLog"("date");

-- AddForeignKey
ALTER TABLE "DietProfile" ADD CONSTRAINT "DietProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodLog" ADD CONSTRAINT "FoodLog_dietProfileId_fkey" FOREIGN KEY ("dietProfileId") REFERENCES "DietProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodLog" ADD CONSTRAINT "FoodLog_foodItemId_fkey" FOREIGN KEY ("foodItemId") REFERENCES "FoodItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
