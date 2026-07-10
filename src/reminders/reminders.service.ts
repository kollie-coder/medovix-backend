// src/reminders/reminders.service.ts
import {
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CreateReminderDto } from './dto/create-reminder.dto'
import { UpdateReminderDto } from './dto/update-reminder.dto'
import { MarkDoseDto } from './dto/mark-dose.dto'

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}

  // ── Get all reminders for the current user ───────────────
  async findAll(userId: string) {
    const reminders = await this.prisma.medicationReminder.findMany({
      where: { userId, deletedAt: null },
      include: {
        doses: {
          where: {
            scheduledAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lt: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return reminders
  }

  // ── Create reminder ──────────────────────────────────────
  async create(userId: string, dto: CreateReminderDto) {
    const reminder = await this.prisma.medicationReminder.create({
      data: {
        userId,
        drugName: dto.drugName,
        dosage: dto.dosage,
        frequency: dto.frequency,
        times: dto.times,
        mealTiming: dto.mealTiming,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        color: dto.color ?? '#0A7EA4',
        notes: dto.notes,
      },
    })

    // Pre-create dose records for the next 7 days
    await this.scheduleDoses(reminder.id, dto.times, dto.startDate, dto.endDate)

    return reminder
  }

  // ── Update reminder ──────────────────────────────────────
  async update(userId: string, id: string, dto: UpdateReminderDto) {
    const reminder = await this.findOwned(userId, id)

    const updated = await this.prisma.medicationReminder.update({
      where: { id: reminder.id },
      data: {
        ...(dto.drugName && { drugName: dto.drugName }),
        ...(dto.dosage && { dosage: dto.dosage }),
        ...(dto.frequency && { frequency: dto.frequency }),
        ...(dto.times && { times: dto.times }),
        ...(dto.mealTiming && { mealTiming: dto.mealTiming }),
        ...(dto.endDate && { endDate: new Date(dto.endDate) }),
        ...(dto.color && { color: dto.color }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    })

    return updated
  }

  // ── Delete reminder (soft delete) ───────────────────────
  async remove(userId: string, id: string) {
    await this.findOwned(userId, id)

    await this.prisma.medicationReminder.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    })

    return { message: 'Reminder deleted' }
  }

  // ── Mark dose taken / skipped / snoozed ─────────────────
  async markDose(userId: string, reminderId: string, dto: MarkDoseDto) {
    await this.findOwned(userId, reminderId)

    const scheduledAt = new Date(dto.scheduledAt)

    // Find or create the dose record
    const existing = await this.prisma.reminderDose.findFirst({
      where: { reminderId, scheduledAt },
    })

    if (existing) {
      return this.prisma.reminderDose.update({
        where: { id: existing.id },
        data: {
          takenAt: dto.taken ? new Date() : null,
          skipped: dto.skipped ?? false,
          snoozedUntil: dto.snoozedUntil ? new Date(dto.snoozedUntil) : null,
        },
      })
    }

    return this.prisma.reminderDose.create({
      data: {
        reminderId,
        scheduledAt,
        takenAt: dto.taken ? new Date() : null,
        skipped: dto.skipped ?? false,
        snoozedUntil: dto.snoozedUntil ? new Date(dto.snoozedUntil) : null,
      },
    })
  }

  // ── Get today's adherence summary ────────────────────────
  async getTodaySummary(userId: string) {
    const today = new Date()
    const start = new Date(today.setHours(0, 0, 0, 0))
    const end = new Date(today.setHours(23, 59, 59, 999))

    const doses = await this.prisma.reminderDose.findMany({
      where: {
        reminder: { userId, deletedAt: null, active: true },
        scheduledAt: { gte: start, lt: end },
      },
      include: {
        reminder: {
          select: { drugName: true, dosage: true, color: true },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    })

    const total = doses.length
    const taken = doses.filter(d => d.takenAt !== null).length
    const skipped = doses.filter(d => d.skipped).length
    const pending = total - taken - skipped

    return {
      total,
      taken,
      skipped,
      pending,
      adherencePercent: total > 0 ? Math.round((taken / total) * 100) : 0,
      doses,
    }
  }

  // ── Private helpers ──────────────────────────────────────

  private async findOwned(userId: string, id: string) {
    const reminder = await this.prisma.medicationReminder.findFirst({
      where: { id, userId, deletedAt: null },
    })
    if (!reminder) {
      throw new NotFoundException('Reminder not found')
    }
    return reminder
  }

  private async scheduleDoses(
    reminderId: string,
    times: string[],
    startDate: string,
    endDate?: string,
  ) {
    const doses: { reminderId: string; scheduledAt: Date }[] = []
    const start = new Date(startDate)
    const end = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const days = Math.min(
      Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
      30, // max 30 days ahead
    )

    for (let day = 0; day < days; day++) {
      for (const time of times) {
        const [hours, minutes] = time.split(':').map(Number)
        const scheduledAt = new Date(start)
        scheduledAt.setDate(start.getDate() + day)
        scheduledAt.setHours(hours, minutes, 0, 0)

        if (scheduledAt > new Date()) {
          doses.push({ reminderId, scheduledAt })
        }
      }
    }

    if (doses.length > 0) {
      await this.prisma.reminderDose.createMany({ data: doses })
    }
  }
}