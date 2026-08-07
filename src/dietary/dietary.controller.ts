// src/dietary/dietary.controller.ts
import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards,
} from '@nestjs/common'
import { DietaryService } from './dietary.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { HealthCondition, ActivityLevel, MealType } from '@prisma/client'

@Controller('dietary')
@UseGuards(JwtAuthGuard)
export class DietaryController {
  constructor(private dietaryService: DietaryService) {}

  // GET /api/v1/dietary/profile
  @Get('profile')
  getProfile(@CurrentUser('id') userId: string) {
    return this.dietaryService.getProfile(userId)
  }

  // PUT /api/v1/dietary/profile
  @Put('profile')
  updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: {
      condition?: HealthCondition
      age?: number
      weight?: number
      height?: number
      activityLevel?: ActivityLevel
    },
  ) {
    return this.dietaryService.updateProfile(userId, dto)
  }

  // GET /api/v1/dietary/summary?date=2026-07-01
  @Get('summary')
  getDailySummary(
    @CurrentUser('id') userId: string,
    @Query('date') date: string,
  ) {
    const today = date ?? new Date().toISOString().split('T')[0]
    return this.dietaryService.getDailySummary(userId, today)
  }

  // GET /api/v1/dietary/weekly?startDate=2026-06-30
  @Get('weekly')
  getWeeklySummary(
    @CurrentUser('id') userId: string,
    @Query('startDate') startDate: string,
  ) {
    return this.dietaryService.getWeeklySummary(userId, startDate)
  }

  // GET /api/v1/dietary/suggestions
  @Get('suggestions')
  getMealSuggestions(@CurrentUser('id') userId: string) {
    return this.dietaryService.getMealSuggestions(userId)
  }

  // GET /api/v1/dietary/food/search?q=rice
  @Get('food/search')
  searchFood(
    @Query('q') query: string,
    @Query('condition') condition?: string,
  ) {
    return this.dietaryService.searchFood(query, condition)
  }

  // GET /api/v1/dietary/food/search-fallback?q=ofada+rice
  // Searches Open Food Facts when our DB has no results
  @Get('food/search-fallback')
  searchFoodFallback(@Query('q') query: string) {
    return this.dietaryService.searchFoodFallback(query)
  }

  // POST /api/v1/dietary/estimate-nutrition
  // Estimates nutrition using Claude AI or Open Food Facts fallback
  @Post('estimate-nutrition')
  estimateNutrition(
    @Body('foodName') foodName: string,
    @Body('portionGrams') portionGrams?: number,
  ) {
    return this.dietaryService.estimateNutrition(foodName, portionGrams ?? 100)
  }
  @Post('log/custom')
  logCustomFood(
    @CurrentUser('id') userId: string,
    @Body() dto: {
      name: string
      mealType: MealType
      calories: number
      carbs: number
      protein: number
      fat: number
      portionGrams: number
      date?: string
    },
  ) {
    return this.dietaryService.logCustomFood(userId, {
      ...dto,
      date: dto.date ?? new Date().toISOString().split('T')[0],
    })
  }

  // POST /api/v1/dietary/log
  @Post('log')
  logFood(
    @CurrentUser('id') userId: string,
    @Body() dto: {
      foodItemId: string
      mealType: MealType
      portionGrams: number
      date?: string
    },
  ) {
    return this.dietaryService.logFood(userId, {
      ...dto,
      date: dto.date ?? new Date().toISOString().split('T')[0],
    })
  }

  // DELETE /api/v1/dietary/log/:id
  @Delete('log/:id')
  deleteLog(
    @CurrentUser('id') userId: string,
    @Param('id') logId: string,
  ) {
    return this.dietaryService.deleteLog(userId, logId)
  }

  // POST /api/v1/dietary/seed (admin use — seeds food database)
  @Post('seed')
  seedFoodDatabase() {
    return this.dietaryService.seedFoodDatabase()
  }
}