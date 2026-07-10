// src/push-tokens/push-tokens.controller.ts
import {
  Controller, Post, Delete, Body, Param, UseGuards,
} from '@nestjs/common'
import { PushTokensService } from './push-tokens.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { IsString, IsEnum } from 'class-validator'

class RegisterPushTokenDto {
  @IsString()
  token: string

  @IsEnum(['ios', 'android'])
  platform: string
}

@Controller('push-tokens')
@UseGuards(JwtAuthGuard)
export class PushTokensController {
  constructor(private pushTokensService: PushTokensService) {}

  // POST /api/v1/push-tokens
  @Post()
  register(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.pushTokensService.register(userId, dto.token, dto.platform)
  }

  // DELETE /api/v1/push-tokens/:token
  @Delete(':token')
  remove(@Param('token') token: string) {
    return this.pushTokensService.remove(token)
  }
}