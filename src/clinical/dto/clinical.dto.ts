import { Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber,
  IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator'
import { LabOrderPriority } from '@prisma/client'

export class VitalsDto {
  @IsOptional() @IsInt() @Min(50) @Max(300) bpSystolic?: number
  @IsOptional() @IsInt() @Min(30) @Max(200) bpDiastolic?: number
  @IsOptional() @IsInt() @Min(20) @Max(300) pulse?: number
  @IsOptional() @IsNumber() @Min(30) @Max(45) temperature?: number
  @IsOptional() @IsInt() @Min(50) @Max(100) spo2?: number
  @IsOptional() @IsNumber() @Min(0.5) @Max(500) weight?: number
  @IsOptional() @IsNumber() @Min(20) @Max(260) height?: number
  @IsOptional() @IsString() @MaxLength(1000) notes?: string
}

export class ConsultationDto {
  @IsString() @MinLength(2) @MaxLength(500) diagnosis!: string
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) symptoms?: string[]
  @IsString() @MinLength(2) @MaxLength(5000) findings!: string
  @IsOptional() @IsString() @MaxLength(5000) notes?: string
  @IsOptional() @IsDateString() followUpDate?: string
}

export class AddendumDto {
  @IsString() @MinLength(3) @MaxLength(5000) note!: string
}

export class PrescriptionItemDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string
  @IsString() @MinLength(1) @MaxLength(100) dosage!: string
  @IsString() @MinLength(1) @MaxLength(100) frequency!: string
  @IsString() @MinLength(1) @MaxLength(100) duration!: string
  @IsOptional() @IsString() @MaxLength(500) instructions?: string
}

export class PrescriptionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PrescriptionItemDto)
  medications!: PrescriptionItemDto[]
  @IsOptional() @IsInt() @Min(0) @Max(12) refillsAllowed?: number
  @IsOptional() @IsDateString() expiryDate?: string
  @IsOptional() @IsString() @MaxLength(1000) notes?: string
  /** Set to true after the doctor has seen the allergy warning and still wants to prescribe. */
  @IsOptional() @IsBoolean() confirmAllergyOverride?: boolean
}

export class LabTestDto {
  @IsString() @MinLength(2) @MaxLength(200) testName!: string
  @IsOptional() @IsEnum(LabOrderPriority) priority?: LabOrderPriority
  @IsOptional() @IsString() @MaxLength(1000) clinicalNotes?: string
}

export class LabOrdersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => LabTestDto)
  tests!: LabTestDto[]
}