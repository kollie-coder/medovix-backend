import { Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateNested,
} from 'class-validator'

export enum ResultFlag {
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  LOW = 'LOW',
  CRITICAL = 'CRITICAL',
}

export class ResultRowDto {
  @IsString() @MinLength(1) @MaxLength(200) parameter!: string
  @IsString() @MinLength(1) @MaxLength(200) value!: string
  @IsOptional() @IsString() @MaxLength(50) unit?: string
  @IsOptional() @IsString() @MaxLength(100) range?: string
  @IsEnum(ResultFlag) flag!: ResultFlag
}

export class EnterResultDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => ResultRowDto)
  results!: ResultRowDto[]
  @IsOptional() @IsString() @MaxLength(3000) impression?: string
}

export class CancelOrderDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
}

export class CorrectionDto {
  @IsString() @MinLength(3) @MaxLength(3000) note!: string
}
