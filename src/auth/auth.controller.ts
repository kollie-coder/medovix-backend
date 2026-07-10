// src/auth/auth.controller.ts
import {
  Controller, Post, Get, Body, UseGuards, HttpCode,
} from '@nestjs/common'
import { AuthService } from './auth.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { CurrentUser } from './decorators/current-user.decorator'

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto)
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto)
  }

  @Post('google')
  @HttpCode(200)
  googleAuth(
    @Body('code') code: string,
    @Body('codeVerifier') codeVerifier: string,
    @Body('redirectUri') redirectUri: string,
  ) {
    return this.authService.googleAuth(code, codeVerifier, redirectUri)
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body('refreshToken') token: string) {
    return this.authService.refresh(token)
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body('refreshToken') token: string) {
    return this.authService.logout(token)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId)
  }
}