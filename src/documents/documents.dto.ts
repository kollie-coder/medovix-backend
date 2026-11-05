import {
  IsBoolean, IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength,
} from 'class-validator'

export class SickNoteDto {
  // First and last day the patient is unfit for work, as dates (YYYY-MM-DD).
  @IsDateString() startDate!: string
  @IsDateString() endDate!: string
  // Off by default: a sick note shown to an employer should not reveal the
  // diagnosis unless the patient agrees.
  @IsOptional() @IsBoolean() includeDiagnosis?: boolean
  @IsOptional() @IsString() @MaxLength(300) diagnosis?: string
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string
}

export enum ReferralUrgency {
  ROUTINE = 'ROUTINE',
  URGENT = 'URGENT',
  EMERGENCY = 'EMERGENCY',
}

export class ReferralDto {
  @IsString() @MinLength(2) @MaxLength(200) referredTo!: string
  @IsOptional() @IsString() @MaxLength(200) department?: string
  @IsEnum(ReferralUrgency) urgency!: ReferralUrgency
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string
  @IsString() @MinLength(3) @MaxLength(4000) clinicalSummary!: string
  @IsOptional() @IsString() @MaxLength(1000) currentMedication?: string
}
