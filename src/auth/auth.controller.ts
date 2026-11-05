import {
  Controller, Post, Get, Put, Body, UseGuards, HttpCode,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { AuthService } from './auth.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { CurrentUser } from './decorators/current-user.decorator'

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('delete-account')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  deleteAccount(
    @CurrentUser('id') userId: string,
    @Body() dto: { password?: string; confirmation?: string },
  ) {
    return this.authService.deleteAccount(userId, dto)
  } 

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto)
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto)
  }

  @Post('google/native')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  googleAuthNative(@Body('idToken') idToken: string) {
    return this.authService.googleAuthNative(idToken)
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


  @Put('change-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(userId, dto)
  }

@Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
@HttpCode(200)
requestPasswordReset(@Body('email') email: string) {
  return this.authService.requestPasswordReset(email)
}
 
@Post('verify-reset-code')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
@HttpCode(200)
verifyResetCode(
  @Body('email') email: string,
  @Body('code') code: string,
) {
  return this.authService.verifyResetCode(email, code)
}
 
@Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
@HttpCode(200)
resetPassword(
  @Body('email') email: string,
  @Body('code') code: string,
  @Body('newPassword') newPassword: string,
) {
  return this.authService.resetPassword(email, code, newPassword)
}
  
  @Post('2fa/setup')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  setup2FA(
    @CurrentUser('id') userId: string,
    @CurrentUser('email') userEmail: string,
  ) {
    return this.authService.setup2FA(userId, userEmail)
  }
  
  @Post('2fa/verify')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  verify2FA(
    @CurrentUser('id') userId: string,
    @Body('code') code: string,
  ) {
    return this.authService.verify2FA(userId, code)
  }
  
  @Post('2fa/disable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  disable2FA(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
  ) {
    return this.authService.disable2FA(userId, password)
  }

   @Post('2fa/backup-codes/regenerate')
    @UseGuards(JwtAuthGuard)
    @HttpCode(200)
    regenerateBackupCodes(
      @CurrentUser('id') userId: string,
      @Body('password') password: string,
    ) {
      return this.authService.regenerateBackupCodes(userId, password)
    }
    
    @Get('2fa/status')
    @UseGuards(JwtAuthGuard)
    getBackupCodeStatus(@CurrentUser('id') userId: string) {
      return this.authService.getBackupCodeStatus(userId)
    }
      
  @Post('2fa/login-verify')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  completeLogin2FA(
    @Body('pendingToken') pendingToken: string,
    @Body('code') code: string,
  ) {
    return this.authService.completeLogin2FA(pendingToken, code)
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: {
      firstName?: string
      lastName?: string
      phone?: string
      dateOfBirth?: string
      gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY'
      bloodGroup?: string
      allergies?: string[]
      weight?: number
      height?: number
    },
  ) {
    return this.authService.updateProfile(userId, dto)
  }
}