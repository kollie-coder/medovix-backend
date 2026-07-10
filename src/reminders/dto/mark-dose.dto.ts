// src/reminders/dto/mark-dose.dto.ts
import {
  IsString, IsEnum, IsArray, IsOptional,
  IsDateString, IsBoolean,
} from 'class-validator'
import { ReminderFrequency, MealTiming } from '@prisma/client'

export class MarkDoseDto {
  @IsDateString()
  scheduledAt: string

  @IsBoolean()
  @IsOptional()
  taken?: boolean

  @IsBoolean()
  @IsOptional()
  skipped?: boolean

  @IsDateString()
  @IsOptional()
  snoozedUntil?: string
}