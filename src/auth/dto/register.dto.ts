// src/auth/dto/register.dto.ts
import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator'
import { Role } from '@prisma/client'

export class RegisterDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(8)
  password: string

  @IsString()
  firstName: string

  @IsString()
  lastName: string

  @IsString()
  @IsOptional()
  phone?: string

  @IsEnum(Role)
  @IsOptional()
  role?: Role
}