import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateNoteTemplateDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string
  @IsOptional() @IsString() @MaxLength(300) symptoms?: string
  @IsOptional() @IsString() @MaxLength(4000) findings?: string
  @IsOptional() @IsString() @MaxLength(4000) notes?: string
}
