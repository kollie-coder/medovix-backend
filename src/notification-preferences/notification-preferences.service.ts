import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

type PreferencesUpdate = {
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
}

@Injectable()
export class NotificationPreferencesService {
  constructor(private prisma: PrismaService) {}

  // ── Get or create preferences with sensible defaults ────
  async getPreferences(userId: string) {
    let prefs = await this.prisma.notificationPreferences.findUnique({
      where: { userId },
    })

    if (!prefs) {
      prefs = await this.prisma.notificationPreferences.create({
        data: { userId },
      })
    }

    return prefs
  }

  // ── Update preferences ───────────────────────────────────
  async updatePreferences(userId: string, dto: PreferencesUpdate) {
    // Basic time format validation for quiet hours
    if (dto.quietHoursStart && !/^\d{2}:\d{2}$/.test(dto.quietHoursStart)) {
      delete dto.quietHoursStart
    }
    if (dto.quietHoursEnd && !/^\d{2}:\d{2}$/.test(dto.quietHoursEnd)) {
      delete dto.quietHoursEnd
    }

    return this.prisma.notificationPreferences.upsert({
      where: { userId },
      update: dto,
      create: { userId, ...dto },
    })
  }

  // ── Check if a given notification type is allowed right now ──
  // Called by the notification-sending logic elsewhere in the app
  // before dispatching a push notification.
  async shouldSend(
    userId: string,
    type: 'doseReminder' | 'missedDoseFollowup' | 'refillAlert' |
          'dailyHealthTip' | 'mealLoggingReminder' | 'appointmentReminder' |
          'careTeamMessage',
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId)

    if (!prefs.allEnabled) return false

    const typeMap: Record<string, boolean> = {
      doseReminder: prefs.doseReminders,
      missedDoseFollowup: prefs.missedDoseFollowup,
      refillAlert: prefs.refillAlerts,
      dailyHealthTip: prefs.dailyHealthTips,
      mealLoggingReminder: prefs.mealLoggingReminders,
      appointmentReminder: prefs.appointmentReminders,
      careTeamMessage: prefs.careTeamMessages,
    }

    if (!typeMap[type]) return false

    // Dose reminders and missed-dose follow-ups ALWAYS ring, even during
    // quiet hours — a medication alert is not safe to silence just because
    // it's night time. Every other notification type respects quiet hours.
    const isCriticalType = type === 'doseReminder' || type === 'missedDoseFollowup'

    if (!isCriticalType && prefs.quietHoursEnabled) {
      if (this.isWithinQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd)) {
        return false
      }
    }

    return true
  }

  // ── Check current time against quiet hours range ─────────
  private isWithinQuietHours(start: string, end: string): boolean {
    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    const [startH, startM] = start.split(':').map(Number)
    const [endH, endM] = end.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes < endMinutes) {
      // Same-day range e.g. 13:00 - 18:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes
    } else {
      // Overnight range e.g. 22:00 - 07:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes
    }
  }
}