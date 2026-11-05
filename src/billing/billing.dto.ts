import { Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional,
  IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator'
import { BillItemType } from '@prisma/client'

// All money is whole kobo (1 naira = 100 kobo). The cap keeps every total
// inside a 32-bit integer: 2,000,000,000 kobo = 20,000,000 naira.
export const MAX_KOBO = 2_000_000_000

export enum PaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CARD = 'CARD',
  POS = 'POS',
}

export class InvoiceItemDto {
  @IsEnum(BillItemType) type!: BillItemType
  @IsString() @MinLength(1) @MaxLength(200) name!: string
  @IsInt() @Min(1) @Max(1000) quantity!: number
  @IsInt() @Min(0) @Max(MAX_KOBO) unitPrice!: number
}

export class CreateInvoiceDto {
  @IsString() @MinLength(1) patientId!: string
  @IsOptional() @IsString() appointmentId?: string
  @IsOptional() @IsDateString() dueDate?: string
  @IsOptional() @IsString() @MaxLength(1000) notes?: string
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[]
}

export class PaymentDto {
  @IsInt() @Min(1) @Max(MAX_KOBO) amount!: number
  @IsEnum(PaymentMethod) method!: PaymentMethod
  @IsOptional() @IsString() @MaxLength(100) reference?: string
  @IsOptional() @IsString() @MaxLength(300) note?: string
}

export class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
}

export class CreatePriceDto {
  @IsEnum(BillItemType) type!: BillItemType
  @IsString() @MinLength(1) @MaxLength(200) name!: string
  @IsInt() @Min(0) @Max(MAX_KOBO) price!: number
}

export class UpdatePriceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string
  @IsOptional() @IsInt() @Min(0) @Max(MAX_KOBO) price?: number
  @IsOptional() @IsBoolean() active?: boolean
}
