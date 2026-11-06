import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator'
import { MealType } from '@prisma/client'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// PATCH /dietary/log/:id — change how much was eaten
export class UpdateLogDto {
  @IsNumber()
  @Min(1)
  @Max(5000)
  portionGrams: number
}

// POST /dietary/log/copy — copy one meal from one day to another
export class CopyMealDto {
  @IsString()
  @Matches(DATE_RE, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate: string

  @IsString()
  @Matches(DATE_RE, { message: 'toDate must be YYYY-MM-DD' })
  toDate: string

  @IsEnum(MealType)
  mealType: MealType
}

// POST /dietary/water — add a drink
export class AddWaterDto {
  @IsInt()
  @Min(50)
  @Max(2000)
  amountMl: number

  @IsOptional()
  @IsString()
  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date?: string
}
