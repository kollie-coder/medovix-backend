// src/reminders/dto/create-reminder.dto.ts
import {
  IsString, IsEnum, IsArray, IsOptional,
  IsDateString, IsBoolean,
} from 'class-validator'
import { ReminderFrequency, MealTiming } from '@prisma/client'

export class CreateReminderDto {
  @IsString()
  drugName: string

  @IsString()
  dosage: string

  @IsEnum(ReminderFrequency)
  @IsOptional()
  frequency?: ReminderFrequency

  @IsArray()
  times: string[] // ["08:00", "20:00"]

  @IsEnum(MealTiming)
  @IsOptional()
  mealTiming?: MealTiming

  @IsDateString()
  startDate: string

  @IsDateString()
  @IsOptional()
  endDate?: string

  @IsString()
  @IsOptional()
  color?: string

  @IsString()
  @IsOptional()
  notes?: string
}