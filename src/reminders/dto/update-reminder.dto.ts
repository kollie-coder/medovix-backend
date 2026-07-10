// src/reminders/dto/update-reminder.dto.ts
import {
  IsString, IsEnum, IsArray, IsOptional,
  IsDateString, IsBoolean,
} from 'class-validator'
import { ReminderFrequency, MealTiming } from '@prisma/client'


export class UpdateReminderDto {
  @IsString()
  @IsOptional()
  drugName?: string

  @IsString()
  @IsOptional()
  dosage?: string

  @IsEnum(ReminderFrequency)
  @IsOptional()
  frequency?: ReminderFrequency

  @IsArray()
  @IsOptional()
  times?: string[]

  @IsEnum(MealTiming)
  @IsOptional()
  mealTiming?: MealTiming

  @IsDateString()
  @IsOptional()
  endDate?: string

  @IsString()
  @IsOptional()
  color?: string

  @IsString()
  @IsOptional()
  notes?: string

  @IsBoolean()
  @IsOptional()
  active?: boolean
}