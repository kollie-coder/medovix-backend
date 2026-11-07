// src/reminders/reminders.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CreateReminderDto } from './dto/create-reminder.dto'
import { UpdateReminderDto } from './dto/update-reminder.dto'
import { MarkDoseDto } from './dto/mark-dose.dto'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RANGE_DAYS = 62

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}

  // ── Time window helper ───────────────────────────────────
  // The app sends the start and end of the patient's LOCAL day as ISO
  // timestamps. Without them we fall back to the current UTC day, which is
  // what the old code did (wrong for anyone not on UTC).
  private parseRange(from?: string, to?: string): { gte: Date; lt: Date } {
    const f = from ? new Date(from) : null
    const t = to ? new Date(to) : null
    if (f && t && !isNaN(f.getTime()) && !isNaN(t.getTime())) {
      if (t <= f) throw new BadRequestException('"to" must be after "from"')
      if (t.getTime() - f.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new BadRequestException(`Range cannot exceed ${MAX_RANGE_DAYS} days`)
      }
      return { gte: f, lt: t }
    }
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    return { gte: start, lt: new Date(start.getTime() + DAY_MS) }
  }

  // ── All reminders (with the doses recorded in the window) ─
  async findAll(userId: string, from?: string, to?: string) {
    return this.prisma.medicationReminder.findMany({
      where: { userId, deletedAt: null },
      include: {
        doses: {
          where: { scheduledAt: this.parseRange(from, to) },
          orderBy: { scheduledAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  // ── Recorded doses over a longer window (for adherence stats) ─
  async getDoses(userId: string, from?: string, to?: string) {
    return this.prisma.reminderDose.findMany({
      where: {
        reminder: { userId, deletedAt: null },
        scheduledAt: this.parseRange(from, to),
      },
      select: {
        reminderId: true, scheduledAt: true, takenAt: true,
        skipped: true, snoozedUntil: true,
      },
      orderBy: { scheduledAt: 'asc' },
    })
  }

  // ── Create ───────────────────────────────────────────────
  async create(userId: string, dto: CreateReminderDto) {
    return this.prisma.medicationReminder.create({
      data: {
        userId,
        drugName: dto.drugName.trim(),
        dosage: dto.dosage.trim(),
        frequency: dto.frequency,
        times: dto.times,
        mealTiming: dto.mealTiming,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        color: dto.color ?? '#0A7EA4',
        notes: dto.notes,
        pillsRemaining: dto.pillsRemaining ?? null,
        pillsPerDose: dto.pillsPerDose ?? 1,
        refillAlertDays: dto.refillAlertDays ?? 7,
      },
    })
    // Dose rows are created only when a dose is marked (see markDose).
    // The old code pre-created rows at server (UTC) clock times, which did
    // not line up with the patient's local times.
  }

  // ── Update ───────────────────────────────────────────────
  async update(userId: string, id: string, dto: UpdateReminderDto) {
    const reminder = await this.findOwned(userId, id)

    const start = dto.startDate ? new Date(dto.startDate) : reminder.startDate
    const end = dto.endDate !== undefined
      ? (dto.endDate ? new Date(dto.endDate) : null)
      : reminder.endDate
    if (end && end < start) {
      throw new BadRequestException('End date cannot be before the start date')
    }

    return this.prisma.medicationReminder.update({
      where: { id: reminder.id },
      data: {
        ...(dto.drugName !== undefined && { drugName: dto.drugName.trim() }),
        ...(dto.dosage !== undefined && { dosage: dto.dosage.trim() }),
        ...(dto.frequency !== undefined && { frequency: dto.frequency }),
        ...(dto.times !== undefined && { times: dto.times }),
        ...(dto.mealTiming !== undefined && { mealTiming: dto.mealTiming }),
        ...(dto.startDate !== undefined && { startDate: start }),
        ...(dto.endDate !== undefined && { endDate: end }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.pillsRemaining !== undefined && { pillsRemaining: dto.pillsRemaining }),
        ...(dto.pillsPerDose !== undefined && { pillsPerDose: dto.pillsPerDose }),
        ...(dto.refillAlertDays !== undefined && { refillAlertDays: dto.refillAlertDays }),
      },
    })
  }

  // ── Soft delete ──────────────────────────────────────────
  async remove(userId: string, id: string) {
    await this.findOwned(userId, id)
    await this.prisma.medicationReminder.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    })
    return { message: 'Reminder deleted' }
  }

  // ── Mark a dose taken / skipped / snoozed / undone ───────
  // Only the fields present in the request change. Taking a dose uses up
  // pills (once — repeating the call or undoing it is safe).
  async markDose(userId: string, reminderId: string, dto: MarkDoseDto) {
    await this.findOwned(userId, reminderId)

    if (dto.taken === true && dto.skipped === true) {
      throw new BadRequestException('A dose cannot be both taken and skipped')
    }

    const scheduledAt = new Date(dto.scheduledAt)
    const now = Date.now()
    if (scheduledAt.getTime() < now - 45 * DAY_MS || scheduledAt.getTime() > now + 2 * DAY_MS) {
      throw new BadRequestException('That dose time is outside the allowed window')
    }

    return this.prisma.$transaction(async tx => {
      const reminder = await tx.medicationReminder.findUnique({ where: { id: reminderId } })
      if (!reminder) throw new NotFoundException('Reminder not found')

      const existing = await tx.reminderDose.findFirst({ where: { reminderId, scheduledAt } })

      let takenAt = existing?.takenAt ?? null
      let skipped = existing?.skipped ?? false
      let snoozedUntil = existing?.snoozedUntil ?? null

      if (dto.taken === true) {
        takenAt = existing?.takenAt ?? new Date() // keep the original time if repeated
        skipped = false
        snoozedUntil = null
      } else if (dto.skipped === true) {
        skipped = true
        takenAt = null
        snoozedUntil = null
      } else {
        if (dto.taken === false) takenAt = null
        if (dto.skipped === false) skipped = false
        if (dto.snoozedUntil !== undefined) {
          snoozedUntil = dto.snoozedUntil ? new Date(dto.snoozedUntil) : null
        }
      }

      // ── Pill accounting ────────────────────────────────
      let pillsDeducted = existing?.pillsDeducted ?? false
      let pillsRemaining = reminder.pillsRemaining
      const nowTaken = takenAt !== null

      if (pillsRemaining !== null) {
        if (nowTaken && !pillsDeducted) {
          const updated = await tx.medicationReminder.update({
            where: { id: reminderId },
            data: { pillsRemaining: { decrement: reminder.pillsPerDose } },
            select: { pillsRemaining: true },
          })
          pillsRemaining = updated.pillsRemaining
          if (pillsRemaining !== null && pillsRemaining < 0) {
            await tx.medicationReminder.update({
              where: { id: reminderId }, data: { pillsRemaining: 0 },
            })
            pillsRemaining = 0
          }
          pillsDeducted = true
        } else if (!nowTaken && pillsDeducted) {
          const updated = await tx.medicationReminder.update({
            where: { id: reminderId },
            data: { pillsRemaining: { increment: reminder.pillsPerDose } },
            select: { pillsRemaining: true },
          })
          pillsRemaining = updated.pillsRemaining
          pillsDeducted = false
        }
      } else if (!nowTaken) {
        pillsDeducted = false
      }

      const data = { takenAt, skipped, snoozedUntil, pillsDeducted }
      const dose = existing
        ? await tx.reminderDose.update({ where: { id: existing.id }, data })
        : await tx.reminderDose.create({ data: { reminderId, scheduledAt, ...data } })

      return { ...dose, pillsRemaining }
    })
  }

  // ── Summary of recorded doses in a window (default: today UTC) ─
  // Note: counts only doses that have a row (taken / skipped / snoozed).
  // The app works out "pending" and "missed" itself from the schedule.
  async getTodaySummary(userId: string, from?: string, to?: string) {
    const doses = await this.prisma.reminderDose.findMany({
      where: {
        reminder: { userId, deletedAt: null, active: true },
        scheduledAt: this.parseRange(from, to),
      },
      include: { reminder: { select: { drugName: true, dosage: true, color: true } } },
      orderBy: { scheduledAt: 'asc' },
    })

    const total = doses.length
    const taken = doses.filter(d => d.takenAt !== null).length
    const skipped = doses.filter(d => d.skipped).length
    const pending = total - taken - skipped

    return {
      total, taken, skipped, pending,
      adherencePercent: total > 0 ? Math.round((taken / total) * 100) : 0,
      doses,
    }
  }

  // ── Private ──────────────────────────────────────────────
  private async findOwned(userId: string, id: string) {
    const reminder = await this.prisma.medicationReminder.findFirst({
      where: { id, userId, deletedAt: null },
    })
    if (!reminder) throw new NotFoundException('Reminder not found')
    return reminder
  }
}
