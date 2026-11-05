import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export const MAX_MESSAGE_LENGTH = 1000

export class CreateStaffMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(64) recipientId!: string
  @IsString() @IsNotEmpty() @MaxLength(64) appointmentId!: string
  @IsString() @IsNotEmpty() @MaxLength(MAX_MESSAGE_LENGTH) body!: string
}

export class ReplyStaffMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(MAX_MESSAGE_LENGTH) body!: string
}
