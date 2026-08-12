// src/dietary/dietary.service.ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { HealthCondition, ActivityLevel, MealType } from '@prisma/client'

// ── Condition-based nutrition targets ─────────────────────
const CONDITION_TARGETS: Record<string, {
  calorieModifier: number
  maxCarbs: number
  minProtein: number
  maxFat: number
  maxSodium: number
  maxSugar: number
  notes: string[]
}> = {
  GENERAL_WELLNESS: {
    calorieModifier: 1.0, maxCarbs: 300, minProtein: 50, maxFat: 65, maxSodium: 2300, maxSugar: 50,
    notes: ['Eat a balanced variety of foods', 'Aim for 5 portions of fruit and veg daily'],
  },
  TYPE2_DIABETES: {
    calorieModifier: 0.9, maxCarbs: 130, minProtein: 60, maxFat: 55, maxSodium: 2000, maxSugar: 25,
    notes: ['Choose low GI carbohydrates', 'Avoid sugary drinks', 'Eat smaller frequent meals', 'Monitor carbohydrate portions carefully'],
  },
  HYPERTENSION: {
    calorieModifier: 0.95, maxCarbs: 250, minProtein: 55, maxFat: 55, maxSodium: 1500, maxSugar: 40,
    notes: ['Follow the DASH diet', 'Limit salt to 1,500mg per day', 'Increase potassium-rich foods', 'Avoid processed foods'],
  },
  HEART_DISEASE: {
    calorieModifier: 0.9, maxCarbs: 225, minProtein: 55, maxFat: 44, maxSodium: 1500, maxSugar: 36,
    notes: ['Limit saturated and trans fats', 'Choose lean proteins and oily fish', 'Increase fibre with whole grains', 'Avoid fried foods'],
  },
  WEIGHT_LOSS: {
    calorieModifier: 0.8, maxCarbs: 200, minProtein: 70, maxFat: 50, maxSodium: 2000, maxSugar: 30,
    notes: ['Create a 500 kcal daily deficit', 'Prioritise protein', 'Fill half your plate with vegetables', 'Avoid liquid calories'],
  },
  PREGNANCY: {
    calorieModifier: 1.1, maxCarbs: 320, minProtein: 70, maxFat: 70, maxSodium: 2300, maxSugar: 50,
    notes: ['Take folic acid daily', 'Increase iron and calcium', 'Avoid raw fish and soft cheeses', 'Stay well hydrated'],
  },
  OSTEOPOROSIS: {
    calorieModifier: 1.0, maxCarbs: 275, minProtein: 60, maxFat: 65, maxSodium: 2000, maxSugar: 40,
    notes: ['Prioritise calcium-rich foods', 'Get adequate vitamin D', 'Limit alcohol and caffeine', 'Include weight-bearing exercise'],
  },
  LACTOSE_INTOLERANCE: {
    calorieModifier: 1.0, maxCarbs: 275, minProtein: 55, maxFat: 65, maxSodium: 2300, maxSugar: 45,
    notes: ['Choose lactose-free or plant-based alternatives', 'Get calcium from fortified foods', 'Read labels for hidden dairy'],
  },
}

function calculateBMR(weight: number, height: number, age: number, isMale = true): number {
  if (isMale) return 10 * weight + 6.25 * height - 5 * age + 5
  return 10 * weight + 6.25 * height - 5 * age - 161
}

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  SEDENTARY: 1.2, LIGHT: 1.375, MODERATE: 1.55, ACTIVE: 1.725, VERY_ACTIVE: 1.9,
}

@Injectable()
export class DietaryService {
  constructor(private prisma: PrismaService) {}

  private async getOrCreateProfile(userId: string) {
    let profile = await this.prisma.dietProfile.findUnique({ where: { userId } })
    if (!profile) {
      // Use upsert instead of plain create — if two requests race to create
      // the profile at the same instant (exactly what was happening before),
      // upsert makes this safe: whichever request "wins" creates the row,
      // and the other just returns the same row instead of erroring on a
      // duplicate unique constraint violation.
      profile = await this.prisma.dietProfile.upsert({
        where: { userId },
        update: {},
        create: { userId },
      })
    }
    return profile
  }

  // ── Get or create diet profile ─────────────────────────
  async getProfile(userId: string) {
  const profile = await this.getOrCreateProfile(userId)
  const targets = CONDITION_TARGETS[profile.condition]
  return { ...profile, conditionGuidance: targets.notes }
}

  // ── Update diet profile ────────────────────────────────
  async updateProfile(userId: string, dto: {
    condition?: HealthCondition
    age?: number
    weight?: number
    height?: number
    activityLevel?: ActivityLevel
  }) {
    const existing = await this.prisma.dietProfile.findUnique({ where: { userId } })
    const weight = dto.weight ?? existing?.weight
    const height = dto.height ?? existing?.height
    const age = dto.age ?? existing?.age
    const condition = dto.condition ?? existing?.condition ?? 'GENERAL_WELLNESS'
    const activity = dto.activityLevel ?? existing?.activityLevel ?? 'MODERATE'

    let calculatedTargets: any = {}
    if (weight && height && age) {
      const bmr = calculateBMR(weight, height, age)
      const tdee = bmr * ACTIVITY_MULTIPLIERS[activity]
      const conditionTargets = CONDITION_TARGETS[condition]
      const dailyCalories = Math.round(tdee * conditionTargets.calorieModifier)
      calculatedTargets = {
        dailyCalories,
        dailyCarbs: Math.min(Math.round(dailyCalories * 0.45 / 4), conditionTargets.maxCarbs),
        dailyProtein: Math.max(Math.round(dailyCalories * 0.20 / 4), conditionTargets.minProtein),
        dailyFat: Math.min(Math.round(dailyCalories * 0.30 / 9), conditionTargets.maxFat),
      }
    }

    return this.prisma.dietProfile.upsert({
      where: { userId },
      update: { ...dto, ...calculatedTargets },
      create: { userId, ...dto, ...calculatedTargets },
    })
  }

  // ── Get daily summary 
  async getDailySummary(userId: string, date: string) {
  const profile = await this.getOrCreateProfile(userId)
 
  const logs = await this.prisma.foodLog.findMany({
    where: { dietProfileId: profile.id, date },
    include: { foodItem: true },
    orderBy: { loggedAt: 'asc' },
  })
 
  const totals = logs.reduce((acc, log) => ({
    calories: acc.calories + log.calories,
    carbs: acc.carbs + log.carbs,
    protein: acc.protein + log.protein,
    fat: acc.fat + log.fat,
  }), { calories: 0, carbs: 0, protein: 0, fat: 0 })
 
  return {
    date,
    totals,
    targets: {
      calories: profile.dailyCalories,
      carbs: profile.dailyCarbs,
      protein: profile.dailyProtein,
      fat: profile.dailyFat,
      water: profile.dailyWater,
    },
    byMeal: {
      BREAKFAST: logs.filter(l => l.mealType === 'BREAKFAST'),
      LUNCH: logs.filter(l => l.mealType === 'LUNCH'),
      DINNER: logs.filter(l => l.mealType === 'DINNER'),
      SNACK: logs.filter(l => l.mealType === 'SNACK'),
    },
    adherencePercent: Math.min(
      Math.round((totals.calories / profile.dailyCalories) * 100), 100
    ),
  }
}
 
//  getWeeklySummary — same fix 
async getWeeklySummary(userId: string, startDate: string) {
  const profile = await this.getOrCreateProfile(userId)
 
  const start = new Date(startDate)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d.toISOString().split('T')[0]
  })
 
  const logs = await this.prisma.foodLog.findMany({
    where: { dietProfileId: profile.id, date: { in: days } },
  })
 
  return days.map(date => {
    const dayLogs = logs.filter(l => l.date === date)
    const calories = dayLogs.reduce((sum, l) => sum + l.calories, 0)
    return {
      date,
      calories: Math.round(calories),
      target: profile.dailyCalories,
      logged: dayLogs.length > 0,
      adherencePercent: Math.min(Math.round((calories / profile.dailyCalories) * 100), 100),
    }
  })
}

  // ── Log a food item ────────────────────────────────────
  async logFood(userId: string, dto: {
    foodItemId: string
    mealType: MealType
    portionGrams: number
    date: string
  }) {
    const profile = await this.prisma.dietProfile.findUnique({ where: { userId } })
    if (!profile) throw new NotFoundException('Diet profile not found')

    const food = await this.prisma.foodItem.findUnique({ where: { id: dto.foodItemId } })
    if (!food) throw new NotFoundException('Food item not found')

    const factor = dto.portionGrams / 100
    return this.prisma.foodLog.create({
      data: {
        dietProfileId: profile.id,
        foodItemId: dto.foodItemId,
        mealType: dto.mealType,
        portionGrams: dto.portionGrams,
        calories: +(food.calories * factor).toFixed(1),
        carbs: +(food.carbs * factor).toFixed(1),
        protein: +(food.protein * factor).toFixed(1),
        fat: +(food.fat * factor).toFixed(1),
        date: dto.date,
      },
      include: { foodItem: true },
    })
  }

  // ── Delete a food log entry ────────────────────────────
  async deleteLog(userId: string, logId: string) {
    const profile = await this.prisma.dietProfile.findUnique({ where: { userId } })
    if (!profile) throw new NotFoundException('Diet profile not found')
    await this.prisma.foodLog.deleteMany({
      where: { id: logId, dietProfileId: profile.id },
    })
    return { message: 'Log deleted' }
  }

  // ── Common stopwords to exclude from search matching ──────
  private readonly STOPWORDS = new Set([
    'and', 'or', 'with', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to',
  ])

  private filterMeaningfulWords(words: string[]): string[] {
    const filtered = words.filter(w => w.length > 1 && !this.STOPWORDS.has(w.toLowerCase()))
    // If filtering removes everything, fall back to original words
    return filtered.length > 0 ? filtered : words.filter(w => w.length > 1)
  }

  // ── Synonym normalization ────────────────────────────────
  // Maps common cooking-method synonyms so "boiled rice" matches "Rice (cooked)"
  private normalizeSynonyms(query: string): string {
    const SYNONYM_MAP: Record<string, string> = {
      boiled: 'cooked',
      steamed: 'cooked',
      grilled: 'grilled', // keep as-is, distinct cooking method
      fried: 'fried',
      roasted: 'grilled',
    }

    return query
      .split(/\s+/)
      .map(word => SYNONYM_MAP[word.toLowerCase()] ?? word)
      .join(' ')
  }

  // ── Search food items (filter avoidFor in app layer) ──
  async searchFood(query: string, condition?: string) {
    const original = this.filterMeaningfulWords(query.trim().split(/\s+/))
    const normalized = this.filterMeaningfulWords(this.normalizeSynonyms(query).trim().split(/\s+/))

    // Try original words first (AND match), fall back to synonym-normalized words
    const tryWords = async (words: string[]) => {
      if (words.length === 0) return []
      const where = {
        AND: words.map(word => ({
          OR: [
            { name: { contains: word, mode: 'insensitive' as const } },
            { category: { contains: word, mode: 'insensitive' as const } },
          ],
        })),
      }
      return this.prisma.foodItem.findMany({ where, take: 30 })
    }

    let results = await tryWords(original)
    if (results.length === 0 && JSON.stringify(normalized) !== JSON.stringify(original)) {
      results = await tryWords(normalized)
    }

    // Rank by relevance: exact name match first, then how many words match, then alphabetical
    const queryLower = query.trim().toLowerCase()
    const ranked = results.sort((a, b) => {
      const aName = a.name.toLowerCase()
      const bName = b.name.toLowerCase()

      const aExact = aName === queryLower ? 1 : 0
      const bExact = bName === queryLower ? 1 : 0
      if (aExact !== bExact) return bExact - aExact

      const aStarts = aName.startsWith(queryLower) ? 1 : 0
      const bStarts = bName.startsWith(queryLower) ? 1 : 0
      if (aStarts !== bStarts) return bStarts - aStarts

      return aName.localeCompare(bName)
    })

    if (condition && condition !== 'GENERAL_WELLNESS') {
      return ranked.filter(f => !f.avoidFor.includes(condition))
    }

    return ranked
  }

  // ── Get meal suggestions ───────────────────────────────
  async getMealSuggestions(userId: string) {
  const profile = await this.getOrCreateProfile(userId)
 
  const condition = profile.condition
 
  const allFoods = await this.prisma.foodItem.findMany({
    where: { suitableFor: { has: condition } },
  })
 
  const suitableFoods = allFoods.filter(f => !f.avoidFor.includes(condition))
 
  const today = new Date()
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) /
    (1000 * 60 * 60 * 24)
  )
 
  const getByCategory = (category: string, count: number) => {
    const items = suitableFoods.filter(f => f.category === category)
    if (items.length === 0) return []
    return Array.from({ length: count }, (_, i) =>
      items[(dayOfYear + i) % items.length]
    )
  }
 
  return {
    condition,
    conditionGuidance: CONDITION_TARGETS[condition].notes,
    date: today.toISOString().split('T')[0],
    meals: {
      BREAKFAST: {
        label: 'Breakfast',
        targetCalories: Math.round(profile.dailyCalories * 0.25),
        suggestions: [
          ...getByCategory('Grains', 1),
          ...getByCategory('Protein', 1),
          ...getByCategory('Fruits', 1),
        ].filter(Boolean),
      },
      LUNCH: {
        label: 'Lunch',
        targetCalories: Math.round(profile.dailyCalories * 0.35),
        suggestions: [
          ...getByCategory('Grains', 1),
          ...getByCategory('Protein', 2),
          ...getByCategory('Vegetables', 2),
        ].filter(Boolean),
      },
      DINNER: {
        label: 'Dinner',
        targetCalories: Math.round(profile.dailyCalories * 0.30),
        suggestions: [
          ...getByCategory('Grains', 1),
          ...getByCategory('Protein', 1),
          ...getByCategory('Vegetables', 2),
        ].filter(Boolean),
      },
      SNACK: {
        label: 'Snacks',
        targetCalories: Math.round(profile.dailyCalories * 0.10),
        suggestions: [
          ...getByCategory('Fruits', 1),
          ...getByCategory('Nuts & Seeds', 1),
        ].filter(Boolean),
      },
    },
  }
}

  // ── Seed food database ─────────────────────────────────
  async seedFoodDatabase() {
    const count = await this.prisma.foodItem.count()
    if (count > 0) return { message: 'Food database already seeded', count }
    const foods = this.getFoodDatabase()
    await this.prisma.foodItem.createMany({ data: foods, skipDuplicates: true })
    return { message: 'Food database seeded', count: foods.length }
  }

  // ── Food database ──────────────────────────────────────
  private getFoodDatabase() {
    const ALL = [
      'GENERAL_WELLNESS', 'TYPE2_DIABETES', 'HYPERTENSION',
      'HEART_DISEASE', 'WEIGHT_LOSS', 'PREGNANCY',
      'OSTEOPOROSIS', 'LACTOSE_INTOLERANCE',
    ]

    return [
      { name: 'Jollof Rice', category: 'Grains', origin: 'nigerian', calories: 185, carbs: 36, protein: 4, fat: 3.5, fibre: 1.2, sodium: 380, sugar: 2, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY'], avoidFor: ['TYPE2_DIABETES'] },
      { name: 'Fried Rice', category: 'Grains', origin: 'nigerian', calories: 200, carbs: 32, protein: 6, fat: 6, fibre: 1.5, sodium: 450, sugar: 2, suitableFor: ['GENERAL_WELLNESS'], avoidFor: ['TYPE2_DIABETES', 'HYPERTENSION', 'HEART_DISEASE'] },
      { name: 'Pounded Yam', category: 'Grains', origin: 'nigerian', calories: 165, carbs: 39, protein: 2, fat: 0.3, fibre: 1.8, sodium: 10, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'OSTEOPOROSIS'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Eba (Garri)', category: 'Grains', origin: 'nigerian', calories: 170, carbs: 40, protein: 1.5, fat: 0.5, fibre: 1.2, sodium: 5, sugar: 0.5, suitableFor: ['GENERAL_WELLNESS', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Amala', category: 'Grains', origin: 'nigerian', calories: 155, carbs: 36, protein: 2, fat: 0.4, fibre: 3.5, sodium: 8, sugar: 0.5, suitableFor: ['GENERAL_WELLNESS', 'HYPERTENSION', 'HEART_DISEASE', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES'] },
      { name: 'Tuwo Shinkafa', category: 'Grains', origin: 'nigerian', calories: 160, carbs: 38, protein: 2.5, fat: 0.3, fibre: 0.8, sodium: 5, sugar: 0.5, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Egusi Soup', category: 'Protein', origin: 'nigerian', calories: 220, carbs: 8, protein: 12, fat: 16, fibre: 2.5, sodium: 320, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'OSTEOPOROSIS', 'HEART_DISEASE'], avoidFor: ['WEIGHT_LOSS'] },
      { name: 'Ogbono Soup', category: 'Protein', origin: 'nigerian', calories: 185, carbs: 5, protein: 10, fat: 14, fibre: 3, sodium: 280, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'HEART_DISEASE'], avoidFor: [] },
      { name: 'Afang Soup', category: 'Vegetables', origin: 'nigerian', calories: 140, carbs: 6, protein: 9, fat: 9, fibre: 4, sodium: 250, sugar: 1, suitableFor: ALL, avoidFor: [] },
      { name: 'Efo Riro', category: 'Vegetables', origin: 'nigerian', calories: 120, carbs: 7, protein: 8, fat: 7, fibre: 3.5, sodium: 220, sugar: 2, suitableFor: ALL, avoidFor: [] },
      { name: 'Edikang Ikong', category: 'Vegetables', origin: 'nigerian', calories: 135, carbs: 5, protein: 10, fat: 8, fibre: 4.2, sodium: 240, sugar: 1, suitableFor: ALL, avoidFor: [] },
      { name: 'Banga Soup', category: 'Protein', origin: 'nigerian', calories: 195, carbs: 6, protein: 9, fat: 15, fibre: 2, sodium: 300, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY'], avoidFor: ['HEART_DISEASE', 'WEIGHT_LOSS'] },
      { name: 'Beans (Black-eyed)', category: 'Protein', origin: 'nigerian', calories: 118, carbs: 20, protein: 8, fat: 0.5, fibre: 7, sodium: 4, sugar: 3, suitableFor: ALL, avoidFor: [] },
      { name: 'Moi Moi', category: 'Protein', origin: 'nigerian', calories: 130, carbs: 15, protein: 9, fat: 4, fibre: 4, sodium: 180, sugar: 2, suitableFor: ['GENERAL_WELLNESS', 'TYPE2_DIABETES', 'HYPERTENSION', 'WEIGHT_LOSS', 'HEART_DISEASE', 'PREGNANCY'], avoidFor: [] },
      { name: 'Akara (Bean Cakes)', category: 'Protein', origin: 'nigerian', calories: 195, carbs: 18, protein: 9, fat: 10, fibre: 3, sodium: 220, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY'], avoidFor: ['HEART_DISEASE', 'WEIGHT_LOSS'] },
      { name: 'Suya (Grilled Beef)', category: 'Protein', origin: 'nigerian', calories: 215, carbs: 2, protein: 26, fat: 11, fibre: 0.5, sodium: 420, sugar: 1, suitableFor: ['GENERAL_WELLNESS', 'WEIGHT_LOSS', 'TYPE2_DIABETES'], avoidFor: ['HYPERTENSION', 'HEART_DISEASE'] },
      { name: 'Grilled Tilapia', category: 'Protein', origin: 'nigerian', calories: 128, carbs: 0, protein: 26, fat: 2.7, fibre: 0, sodium: 56, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Grilled Catfish', category: 'Protein', origin: 'nigerian', calories: 119, carbs: 0, protein: 23, fat: 2.5, fibre: 0, sodium: 50, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Plantain (Boiled)', category: 'Fruits', origin: 'nigerian', calories: 116, carbs: 31, protein: 1.2, fat: 0.2, fibre: 2.3, sodium: 4, sugar: 14, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'HEART_DISEASE', 'OSTEOPOROSIS'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Plantain (Fried)', category: 'Fruits', origin: 'nigerian', calories: 220, carbs: 36, protein: 1.5, fat: 8, fibre: 2, sodium: 5, sugar: 16, suitableFor: ['GENERAL_WELLNESS'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS', 'HEART_DISEASE'] },
      { name: 'Yam (Boiled)', category: 'Grains', origin: 'nigerian', calories: 118, carbs: 28, protein: 1.5, fat: 0.2, fibre: 4, sodium: 9, sugar: 0.5, suitableFor: ['GENERAL_WELLNESS', 'HEART_DISEASE', 'PREGNANCY', 'HYPERTENSION'], avoidFor: ['TYPE2_DIABETES'] },
      { name: 'Sweet Potato (Boiled)', category: 'Vegetables', origin: 'nigerian', calories: 86, carbs: 20, protein: 1.6, fat: 0.1, fibre: 3, sodium: 55, sugar: 4.2, suitableFor: ['GENERAL_WELLNESS', 'HYPERTENSION', 'HEART_DISEASE', 'WEIGHT_LOSS', 'PREGNANCY', 'OSTEOPOROSIS'], avoidFor: [] },
      { name: 'Ugwu (Fluted Pumpkin)', category: 'Vegetables', origin: 'nigerian', calories: 25, carbs: 4, protein: 2.5, fat: 0.4, fibre: 2, sodium: 10, sugar: 1, suitableFor: ALL, avoidFor: [] },
      { name: 'Water Leaf', category: 'Vegetables', origin: 'nigerian', calories: 20, carbs: 3, protein: 2, fat: 0.3, fibre: 1.5, sodium: 8, sugar: 0.5, suitableFor: ALL, avoidFor: [] },
      { name: 'Bitter Leaf', category: 'Vegetables', origin: 'nigerian', calories: 18, carbs: 3, protein: 1.8, fat: 0.2, fibre: 2, sodium: 6, sugar: 0.3, suitableFor: ALL, avoidFor: [] },
      { name: 'Tiger Nut (Kunu)', category: 'Beverages', origin: 'nigerian', calories: 95, carbs: 14, protein: 2, fat: 4, fibre: 6, sodium: 5, sugar: 4, suitableFor: ['GENERAL_WELLNESS', 'LACTOSE_INTOLERANCE', 'PREGNANCY', 'OSTEOPOROSIS'], avoidFor: [] },
      { name: 'Zobo (Hibiscus drink)', category: 'Beverages', origin: 'nigerian', calories: 40, carbs: 9, protein: 0.5, fat: 0.1, fibre: 0.5, sodium: 5, sugar: 8, suitableFor: ['GENERAL_WELLNESS', 'HYPERTENSION'], avoidFor: ['PREGNANCY'] },
      { name: 'Pap (Ogi/Akamu)', category: 'Grains', origin: 'nigerian', calories: 65, carbs: 14, protein: 1, fat: 0.5, fibre: 0.8, sodium: 3, sugar: 0.5, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: [] },
      { name: 'Groundnuts (Peanuts)', category: 'Nuts & Seeds', origin: 'nigerian', calories: 567, carbs: 16, protein: 26, fat: 49, fibre: 8.5, sodium: 18, sugar: 4, suitableFor: ['GENERAL_WELLNESS', 'TYPE2_DIABETES', 'HEART_DISEASE', 'WEIGHT_LOSS', 'PREGNANCY'], avoidFor: [] },
      { name: 'Brown Rice (cooked)', category: 'Grains', origin: 'international', calories: 123, carbs: 26, protein: 2.7, fat: 1, fibre: 1.6, sodium: 1, sugar: 0.4, suitableFor: ALL, avoidFor: [] },
      { name: 'White Rice (cooked)', category: 'Grains', origin: 'international', calories: 130, carbs: 28, protein: 2.7, fat: 0.3, fibre: 0.4, sodium: 1, sugar: 0.1, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Whole Wheat Bread', category: 'Grains', origin: 'international', calories: 247, carbs: 41, protein: 13, fat: 3.4, fibre: 6, sodium: 400, sugar: 5, suitableFor: ['GENERAL_WELLNESS', 'HEART_DISEASE', 'HYPERTENSION', 'WEIGHT_LOSS', 'LACTOSE_INTOLERANCE'], avoidFor: [] },
      { name: 'Oatmeal (cooked)', category: 'Grains', origin: 'international', calories: 71, carbs: 12, protein: 2.5, fat: 1.5, fibre: 2, sodium: 49, sugar: 0.3, suitableFor: ALL, avoidFor: [] },
      { name: 'Quinoa (cooked)', category: 'Grains', origin: 'international', calories: 120, carbs: 21, protein: 4.4, fat: 1.9, fibre: 2.8, sodium: 7, sugar: 0.9, suitableFor: ALL, avoidFor: [] },
      { name: 'Chicken Breast (grilled)', category: 'Protein', origin: 'international', calories: 165, carbs: 0, protein: 31, fat: 3.6, fibre: 0, sodium: 74, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Salmon (grilled)', category: 'Protein', origin: 'international', calories: 208, carbs: 0, protein: 20, fat: 13, fibre: 0, sodium: 59, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Tuna (canned in water)', category: 'Protein', origin: 'international', calories: 116, carbs: 0, protein: 26, fat: 1, fibre: 0, sodium: 320, sugar: 0, suitableFor: ['GENERAL_WELLNESS', 'WEIGHT_LOSS', 'TYPE2_DIABETES', 'HEART_DISEASE', 'LACTOSE_INTOLERANCE'], avoidFor: ['HYPERTENSION', 'PREGNANCY'] },
      { name: 'Eggs (boiled)', category: 'Protein', origin: 'international', calories: 155, carbs: 1.1, protein: 13, fat: 11, fibre: 0, sodium: 124, sugar: 1.1, suitableFor: ALL, avoidFor: [] },
      { name: 'Greek Yogurt (plain)', category: 'Dairy', origin: 'international', calories: 59, carbs: 3.6, protein: 10, fat: 0.4, fibre: 0, sodium: 36, sugar: 3.2, suitableFor: ['GENERAL_WELLNESS', 'TYPE2_DIABETES', 'WEIGHT_LOSS', 'PREGNANCY', 'OSTEOPOROSIS', 'HEART_DISEASE'], avoidFor: ['LACTOSE_INTOLERANCE'] },
      { name: 'Low-fat Milk', category: 'Dairy', origin: 'international', calories: 42, carbs: 5, protein: 3.4, fat: 1, fibre: 0, sodium: 44, sugar: 5, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'OSTEOPOROSIS', 'WEIGHT_LOSS'], avoidFor: ['LACTOSE_INTOLERANCE'] },
      { name: 'Soya Milk', category: 'Dairy', origin: 'international', calories: 33, carbs: 2.4, protein: 2.9, fat: 1.5, fibre: 0.5, sodium: 51, sugar: 1.5, suitableFor: ALL, avoidFor: [] },
      { name: 'Broccoli (steamed)', category: 'Vegetables', origin: 'international', calories: 35, carbs: 7, protein: 2.4, fat: 0.4, fibre: 2.6, sodium: 41, sugar: 1.7, suitableFor: ALL, avoidFor: [] },
      { name: 'Spinach (raw)', category: 'Vegetables', origin: 'international', calories: 23, carbs: 3.6, protein: 2.9, fat: 0.4, fibre: 2.2, sodium: 79, sugar: 0.4, suitableFor: ALL, avoidFor: [] },
      { name: 'Tomatoes', category: 'Vegetables', origin: 'international', calories: 18, carbs: 3.9, protein: 0.9, fat: 0.2, fibre: 1.2, sodium: 5, sugar: 2.6, suitableFor: ALL, avoidFor: [] },
      { name: 'Cucumber', category: 'Vegetables', origin: 'international', calories: 15, carbs: 3.6, protein: 0.7, fat: 0.1, fibre: 0.5, sodium: 2, sugar: 1.7, suitableFor: ALL, avoidFor: [] },
      { name: 'Carrots', category: 'Vegetables', origin: 'international', calories: 41, carbs: 10, protein: 0.9, fat: 0.2, fibre: 2.8, sodium: 69, sugar: 4.7, suitableFor: ALL, avoidFor: [] },
      { name: 'Avocado', category: 'Fruits', origin: 'international', calories: 160, carbs: 9, protein: 2, fat: 15, fibre: 7, sodium: 7, sugar: 0.7, suitableFor: ['GENERAL_WELLNESS', 'TYPE2_DIABETES', 'HEART_DISEASE', 'WEIGHT_LOSS', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: [] },
      { name: 'Banana', category: 'Fruits', origin: 'international', calories: 89, carbs: 23, protein: 1.1, fat: 0.3, fibre: 2.6, sodium: 1, sugar: 12, suitableFor: ['GENERAL_WELLNESS', 'HYPERTENSION', 'PREGNANCY', 'OSTEOPOROSIS', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Apple', category: 'Fruits', origin: 'international', calories: 52, carbs: 14, protein: 0.3, fat: 0.2, fibre: 2.4, sodium: 1, sugar: 10, suitableFor: ALL, avoidFor: [] },
      { name: 'Orange', category: 'Fruits', origin: 'international', calories: 47, carbs: 12, protein: 0.9, fat: 0.1, fibre: 2.4, sodium: 0, sugar: 9, suitableFor: ALL, avoidFor: [] },
      { name: 'Watermelon', category: 'Fruits', origin: 'international', calories: 30, carbs: 8, protein: 0.6, fat: 0.2, fibre: 0.4, sodium: 1, sugar: 6, suitableFor: ['GENERAL_WELLNESS', 'HYPERTENSION', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES'] },
      { name: 'Mango', category: 'Fruits', origin: 'international', calories: 60, carbs: 15, protein: 0.8, fat: 0.4, fibre: 1.6, sodium: 1, sugar: 14, suitableFor: ['GENERAL_WELLNESS', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: ['TYPE2_DIABETES', 'WEIGHT_LOSS'] },
      { name: 'Almonds', category: 'Nuts & Seeds', origin: 'international', calories: 579, carbs: 22, protein: 21, fat: 50, fibre: 12.5, sodium: 1, sugar: 4.4, suitableFor: ALL, avoidFor: [] },
      { name: 'Walnuts', category: 'Nuts & Seeds', origin: 'international', calories: 654, carbs: 14, protein: 15, fat: 65, fibre: 6.7, sodium: 2, sugar: 2.6, suitableFor: ['GENERAL_WELLNESS', 'HEART_DISEASE', 'TYPE2_DIABETES', 'WEIGHT_LOSS', 'PREGNANCY', 'LACTOSE_INTOLERANCE'], avoidFor: [] },
      { name: 'Lentils (cooked)', category: 'Protein', origin: 'international', calories: 116, carbs: 20, protein: 9, fat: 0.4, fibre: 7.9, sodium: 2, sugar: 1.8, suitableFor: ALL, avoidFor: [] },
      { name: 'Chickpeas (cooked)', category: 'Protein', origin: 'international', calories: 164, carbs: 27, protein: 9, fat: 2.6, fibre: 7.6, sodium: 7, sugar: 4.8, suitableFor: ALL, avoidFor: [] },
      { name: 'Tofu', category: 'Protein', origin: 'international', calories: 76, carbs: 1.9, protein: 8, fat: 4.8, fibre: 0.3, sodium: 7, sugar: 0.5, suitableFor: ALL, avoidFor: [] },
      { name: 'Olive Oil', category: 'Fats', origin: 'international', calories: 884, carbs: 0, protein: 0, fat: 100, fibre: 0, sodium: 2, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Water (plain)', category: 'Beverages', origin: 'international', calories: 0, carbs: 0, protein: 0, fat: 0, fibre: 0, sodium: 0, sugar: 0, suitableFor: ALL, avoidFor: [] },
      { name: 'Green Tea', category: 'Beverages', origin: 'international', calories: 2, carbs: 0.5, protein: 0.3, fat: 0, fibre: 0, sodium: 1, sugar: 0, suitableFor: ALL, avoidFor: [] },
    ]
  }

  // ── Open Food Facts fallback search ─────────────────────
  async searchFoodFallback(query: string) {
    try {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?` +
        `search_terms=${encodeURIComponent(query)}` +
        `&search_simple=1&action=process&json=1&page_size=10` +
        `&fields=product_name,nutriments,serving_size,image_url`

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Medovix - Healthcare App - Android/iOS - Version 1.0' },
      })

      if (!response.ok) return []

      const data = await response.json()

      return (data.products ?? [])
        .filter((p: any) =>
          p.product_name &&
          p.nutriments?.['energy-kcal_100g'] != null
        )
        .map((p: any) => ({
          id: `off_${p.code ?? p.product_name.replace(/\s+/g, '_')}`,
          name: p.product_name,
          category: 'International',
          origin: 'international',
          calories: Math.round(p.nutriments['energy-kcal_100g'] ?? 0),
          carbs: Math.round(p.nutriments['carbohydrates_100g'] ?? 0),
          protein: Math.round(p.nutriments['proteins_100g'] ?? 0),
          fat: Math.round(p.nutriments['fat_100g'] ?? 0),
          fibre: Math.round(p.nutriments['fiber_100g'] ?? 0),
          sodium: Math.round((p.nutriments['sodium_100g'] ?? 0) * 1000),
          sugar: Math.round(p.nutriments['sugars_100g'] ?? 0),
          suitableFor: ['GENERAL_WELLNESS'],
          avoidFor: [],
          fromOpenFoodFacts: true,
          servingSize: p.serving_size ?? null,
          imageUrl: p.image_url ?? null,
        }))
    } catch (err) {
      console.error('Open Food Facts error:', err)
      return []
    }
  }

  // ── Log custom food (not in database) ───────────────────
  async logCustomFood(userId: string, dto: {
    name: string
    mealType: MealType
    calories: number
    carbs: number
    protein: number
    fat: number
    portionGrams: number
    date: string
  }) {
    const profile = await this.prisma.dietProfile.findUnique({ where: { userId } })
    if (!profile) throw new NotFoundException('Diet profile not found')

    const foodItem = await this.prisma.foodItem.create({
      data: {
        name: dto.name,
        category: 'Custom',
        origin: 'custom',
        calories: dto.calories / (dto.portionGrams / 100),
        carbs: dto.carbs / (dto.portionGrams / 100),
        protein: dto.protein / (dto.portionGrams / 100),
        fat: dto.fat / (dto.portionGrams / 100),
        fibre: 0,
        sodium: 0,
        sugar: 0,
        suitableFor: ['GENERAL_WELLNESS'],
        avoidFor: [],
      },
    })

    return this.prisma.foodLog.create({
      data: {
        dietProfileId: profile.id,
        foodItemId: foodItem.id,
        mealType: dto.mealType,
        portionGrams: dto.portionGrams,
        calories: dto.calories,
        carbs: dto.carbs,
        protein: dto.protein,
        fat: dto.fat,
        date: dto.date,
      },
      include: { foodItem: true },
    })
  }

  // ── Nutrition estimation (own DB first, then AI, then Open Food Facts) ──
  async estimateNutrition(foodName: string, portionGrams: number = 100) {
    console.log('=== Estimate nutrition for:', foodName, '===')

    const ownMatches = await this.searchFood(foodName)
    console.log('Own DB matches:', ownMatches.length)

    if (ownMatches.length > 0) {
      const best = ownMatches[0]
      const factor = portionGrams / 100
      console.log('Own DB best match:', best.name)
      return {
        foodName, portionGrams,
        calories: Math.round(best.calories * factor),
        carbs: Math.round(best.carbs * factor),
        protein: Math.round(best.protein * factor),
        fat: Math.round(best.fat * factor),
        source: 'ownDatabase' as const,
        confidence: 'high' as const,
        matchedFood: best.name,
        disclaimer: `Matched to "${best.name}" in our food database.`,
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    console.log('Claude API key present:', !!apiKey)
    if (apiKey) {
      try {
        const result = await this.estimateWithClaude(foodName, portionGrams, apiKey)
        if (result) return result
      } catch (err) {
        console.error('Claude estimation failed, falling back to Open Food Facts:', err)
      }
    }

    console.log('Falling through to Open Food Facts...')
    return this.estimateWithOpenFoodFacts(foodName, portionGrams)
  }

  // ── Claude AI estimation ───────────────────────────────────
  private async estimateWithClaude(foodName: string, portionGrams: number, apiKey: string) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Estimate the nutritional values for "${foodName}" per ${portionGrams}g portion.
Reply ONLY with a JSON object in this exact format, no other text:
{"calories":0,"carbs":0,"protein":0,"fat":0,"confidence":"high|medium|low"}
Base your estimates on typical Nigerian/African or international food data.`,
        }],
      }),
    })

    if (!response.ok) throw new Error(`Claude API error: ${response.status}`)

    const data = await response.json()
    const text = data.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text.trim())

    return {
      foodName,
      portionGrams,
      calories: Math.round(parsed.calories),
      carbs: Math.round(parsed.carbs),
      protein: Math.round(parsed.protein),
      fat: Math.round(parsed.fat),
      source: 'ai' as const,
      confidence: parsed.confidence ?? 'medium',
      disclaimer: 'AI estimated values — may vary. Edit before logging if needed.',
    }
  }

  // ── Open Food Facts fallback estimation ───────────────────
  private async estimateWithOpenFoodFacts(foodName: string, portionGrams: number) {
    // The legacy cgi/search.pl endpoint actually performs free-text search correctly.
    // The v2 /api/v2/search endpoint's product_name param does NOT filter by text
    // (confirmed: it returns unrelated products regardless of query) — do not use it for search.
    const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?` +
      `search_terms=${encodeURIComponent(foodName)}` +
      `&search_simple=1&json=1&page_size=20` +
      `&fields=product_name,nutriments`

    const headers = {
      'User-Agent': 'Medovix - Healthcare App - Android/iOS - Version 1.0',
      'Accept': 'application/json',
    }

    try {
      console.log('OFF estimate URL:', searchUrl)
      let response = await fetch(searchUrl, { headers })
      console.log('OFF estimate status:', response.status)

      // Retry up to 2 times on transient 503s
      let attempts = 0
      while (!response.ok && attempts < 2) {
        attempts++
        await new Promise(r => setTimeout(r, 800 * attempts))
        response = await fetch(searchUrl, { headers })
        console.log(`OFF estimate retry ${attempts} status:`, response.status)
      }

      if (!response.ok) throw new Error(`Open Food Facts unavailable (${response.status})`)

      const data = await response.json()
      console.log('OFF estimate products count:', data.products?.length)

      const productsRaw = data.products ?? data.hits ?? []

      const searchWords = this.filterMeaningfulWords(foodName.toLowerCase().split(/\s+/))

      // Hard requirement: product name must contain at least one search word.
      // Without this, irrelevant products (e.g. cheese for "rice") can slip through.
      const products = productsRaw.filter((p: any) => {
        if (!p.product_name || p.nutriments?.['energy-kcal_100g'] == null) return false
        const name = p.product_name.toLowerCase()
        return searchWords.some((w: string) => name.includes(w))
      })

      console.log('OFF estimate filtered count:', products.length)

      if (products.length === 0) {
        return {
          foodName, portionGrams, calories: 0, carbs: 0, protein: 0, fat: 0,
          source: 'unknown' as const, confidence: 'none' as const,
          disclaimer: 'Could not estimate nutrition for this food. Please enter values manually or log without data.',
        }
      }

      // Score products by name match quality + calorie plausibility
      // to avoid matching plain search terms (e.g. "rice") to snacks (e.g. rice cakes at 1900 kcal)

      // Known brand/snack keywords that indicate a processed product, not the base food
      const BRAND_PENALTY_WORDS = [
        'krispies', 'kellogg', 'nestle', 'cereal', 'cakes', 'crackers',
        'snack', 'chips', 'crisps', 'pudding', 'cookie', 'biscuit',
        'flavoured', 'flavored', 'instant', 'ready meal', 'frozen meal',
        'sauce', 'drink', 'juice', 'syrup', 'candy', 'sweet', 'dessert',
      ]

      const scored = products.map((p: any) => {
        const name = p.product_name.toLowerCase()
        const nameWords = name.split(/\s+/)

        const matchCount = searchWords.filter((w: string) => name.includes(w)).length
        const lengthPenalty = Math.max(0, nameWords.length - searchWords.length - 2) * 0.7
        const kcal = p.nutriments['energy-kcal_100g'] ?? 0
        const plausibilityBonus = (kcal >= 20 && kcal <= 400) ? 1 : 0

        const startsWithBonus = name.startsWith(searchWords[0]) ? 1.5 : 0

        // Exact match bonus — product name IS just the search term (e.g. "rice" === "rice")
        const exactMatchBonus = name === foodName.toLowerCase() ? 3 : 0

        // Penalise branded/processed snack products heavily
        const brandPenalty = BRAND_PENALTY_WORDS.some(w => name.includes(w)) ? 3 : 0

        const score = matchCount + plausibilityBonus + startsWithBonus + exactMatchBonus - lengthPenalty - brandPenalty
        return { product: p, score }
      })

      scored.sort((a: any, b: any) => b.score - a.score)
      const best = scored[0].product

      console.log('OFF estimate best match:', best.product_name, 'score:', scored[0].score)

      const factor = portionGrams / 100

      return {
        foodName, portionGrams,
        calories: Math.round((best.nutriments['energy-kcal_100g'] ?? 0) * factor),
        carbs: Math.round((best.nutriments['carbohydrates_100g'] ?? 0) * factor),
        protein: Math.round((best.nutriments['proteins_100g'] ?? 0) * factor),
        fat: Math.round((best.nutriments['fat_100g'] ?? 0) * factor),
        source: 'openfoodfacts' as const, confidence: 'medium' as const,
        matchedFood: best.product_name,
        disclaimer: `Values from Open Food Facts based on "${best.product_name}". Please verify and edit if needed.`,
      }
    } catch (err) {
      console.error('OFF estimate error:', err)
      return {
        foodName, portionGrams, calories: 0, carbs: 0, protein: 0, fat: 0,
        source: 'unknown' as const, confidence: 'none' as const,
        disclaimer: 'Could not estimate nutrition for this food. Please enter values manually or log without data.',
      }
    }
  }
}