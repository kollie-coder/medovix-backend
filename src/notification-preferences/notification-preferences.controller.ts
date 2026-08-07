import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common'
import { NotificationPreferencesService } from './notification-preferences.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'

@Controller('notification-preferences')
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private prefsService: NotificationPreferencesService) {}

  @Get()
  getPreferences(@CurrentUser('id') userId: string) {
    return this.prefsService.getPreferences(userId)
  }

  @Put()
  updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() dto: {
      allEnabled?: boolean
      doseReminders?: boolean
      missedDoseFollowup?: boolean
      refillAlerts?: boolean
      dailyHealthTips?: boolean
      mealLoggingReminders?: boolean
      appointmentReminders?: boolean
      careTeamMessages?: boolean
      quietHoursEnabled?: boolean
      quietHoursStart?: string
      quietHoursEnd?: string
    },
  ) {
    return this.prefsService.updatePreferences(userId, dto)
  }
}