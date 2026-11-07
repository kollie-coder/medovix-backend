// src/reminders/dto/create-reminder.dto.ts
import { ReminderFrequency, MealTiming } from '@prisma/client'
import { Transform } from 'class-transformer'
import {
  IsArray, ArrayMinSize, ArrayMaxSize, IsDateString, IsEnum, IsInt,
  IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator'

export const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

// '' (an empty form field) is treated as "not provided"
const blankToUndefined = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value

export class CreateReminderDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  drugName: string

  @IsString() @IsNotEmpty() @MaxLength(50)
  dosage: string

  @IsOptional() @IsEnum(ReminderFrequency)
  frequency?: ReminderFrequency

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @Matches(HH_MM, { each: true, message: 'Each time must look like 08:00' })
  times: string[]

  @IsOptional() @IsEnum(MealTiming)
  mealTiming?: MealTiming

  @IsDateString()
  startDate: string

  @IsOptional() @Transform(blankToUndefined) @IsDateString()
  endDate?: string

  @IsOptional() @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string

  /** Estimated pills in hand. Leave out to not track supply. */
  @IsOptional() @IsInt() @Min(0) @Max(100000)
  pillsRemaining?: number

  @IsOptional() @IsInt() @Min(1) @Max(20)
  pillsPerDose?: number

  /** Warn this many days before the supply runs out. */
  @IsOptional() @IsInt() @Min(1) @Max(60)
  refillAlertDays?: number
}
