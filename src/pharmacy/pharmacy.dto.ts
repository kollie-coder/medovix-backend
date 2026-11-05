import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class DispenseDto {
  /** Set to true after the pharmacist has seen the allergy warning and still wants to dispense. */
  @IsOptional() @IsBoolean() confirmAllergyOverride?: boolean
}

export class DeclineDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
}
