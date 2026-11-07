import { ReminderFrequency, MealTiming } from '@prisma/client'
import { Transform } from 'class-transformer'
import {
  IsArray, ArrayMinSize, ArrayMaxSize, IsBoolean, IsDateString, IsEnum, IsInt,
  IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator'
import { HH_MM } from './create-reminder.dto'

// '' means "clear this value"
const blankToNull = ({ value }: { value: unknown }) => (value === '' ? null : value)

// Every field is optional. IsOptional also lets `null` through, which is how
// endDate / pillsRemaining are cleared.
export class UpdateReminderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  drugName?: string

  @IsOptional() @IsString() @MinLength(1) @MaxLength(50)
  dosage?: string

  @IsOptional() @IsEnum(ReminderFrequency)
  frequency?: ReminderFrequency

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @Matches(HH_MM, { each: true, message: 'Each time must look like 08:00' })
  times?: string[]

  @IsOptional() @IsEnum(MealTiming)
  mealTiming?: MealTiming

  @IsOptional() @IsDateString()
  startDate?: string

  @IsOptional() @Transform(blankToNull) @IsDateString()
  endDate?: string | null

  @IsOptional() @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string

  @IsOptional() @IsBoolean()
  active?: boolean

  /** Set a number to (re)start tracking / record a refill; null stops tracking. */
  @IsOptional() @IsInt() @Min(0) @Max(100000)
  pillsRemaining?: number | null

  @IsOptional() @IsInt() @Min(1) @Max(20)
  pillsPerDose?: number

  @IsOptional() @IsInt() @Min(1) @Max(60)
  refillAlertDays?: number
}
