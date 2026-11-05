import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { ReferralUrgency } from '../documents/documents.dto'

export class FollowUpDto {
  @IsDateString() scheduledAt!: string
  @IsOptional() @IsString() @MaxLength(300) reason?: string
}

// Refer the patient to a colleague in the same hospital, and book them in.
export class InternalReferralDto {
  @IsString() @MinLength(1) doctorId!: string
  @IsDateString() scheduledAt!: string
  @IsEnum(ReferralUrgency) urgency!: ReferralUrgency
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string
  @IsString() @MinLength(3) @MaxLength(4000) clinicalSummary!: string
  @IsOptional() @IsString() @MaxLength(1000) currentMedication?: string
}
