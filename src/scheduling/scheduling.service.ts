import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomInt } from 'crypto'
import { AppointmentStatus, AppointmentType, ClinicalDocumentType, Prisma, Role } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { FollowUpDto, InternalReferralDto } from './scheduling.dto'
import { auditMeta } from '../common/request-context'

const SLOT_MINUTES = 30
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
// Appointments in these states no longer take up the doctor's time.
const FREE_STATES: AppointmentStatus[] = [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW]

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function newReference() {
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return `MD-${out.slice(0, 4)}-${out.slice(4)}`
}

function parseDate(value: string, label: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label}`)
  return d
}

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name)

  constructor(private prisma: PrismaService) {}

  private async audit(hospitalId: string, userId: string, action: string, entity: string, entityId: string, after?: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({ data: { hospitalId, userId, action, entity, entityId, after: after ?? undefined, ...auditMeta() } })
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`)
    }
  }

  private async notify(userId: string, title: string, body: string, type: string, data?: Record<string, any>) {
    try {
      await this.prisma.notification.create({ data: { userId, title, body, type, data: data ?? undefined } })
    } catch (err) {
      this.logger.error(`Failed to create notification: ${(err as Error).message}`)
    }
  }

  private fmt(d: Date) {
    // Nigeria is on a fixed UTC+1, so this reads correctly for the hospital.
    return new Date(d.getTime() + 60 * MINUTE_MS).toISOString().replace('T', ' ').slice(0, 16) + ' (WAT)'
  }

  /** The doctor's own appointment, open or finished. */
  private async ownVisit(hospitalId: string, id: string, doctorId: string) {
    const a = await this.prisma.appointment.findFirst({
      where: { id, hospitalId, doctorId, deletedAt: null },
      select: {
        id: true, status: true, patientId: true,
        patient: { select: { firstName: true, lastName: true } },
        doctor: { select: { firstName: true, lastName: true } },
      },
    })
    if (!a) throw new NotFoundException('Appointment not found')
    if (a.status !== AppointmentStatus.IN_PROGRESS && a.status !== AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Start the consultation first')
    }
    return a
  }

  private checkSlotTime(start: Date) {
    const now = Date.now()
    if (start.getTime() < now - 5 * MINUTE_MS) throw new BadRequestException('That time has already passed')
    if (start.getTime() > now + 365 * DAY_MS) throw new BadRequestException('Please choose a date within the next year')
    if (start.getUTCMinutes() % SLOT_MINUTES !== 0 || start.getUTCSeconds() !== 0) {
      throw new BadRequestException('Please choose a time on the hour or half hour')
    }
  }

  // ── Reading ─────────────────────────────────────────────

  /** Colleagues a patient can be referred to. */
  async listDoctors(hospitalId: string, meId: string) {
    const doctors = await this.prisma.user.findMany({
      where: { hospitalId, role: Role.DOCTOR, active: true, deletedAt: null, id: { not: meId } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true, firstName: true, lastName: true,
        department: { select: { name: true } },
        staffProfile: { select: { specialization: true } },
      },
    })
    return doctors.map((d) => ({
      id: d.id,
      name: `Dr ${d.firstName} ${d.lastName}`,
      department: d.department?.name ?? null,
      specialization: d.staffProfile?.specialization ?? null,
    }))
  }

  /** Time ranges already taken for one doctor. Shows no patient information. */
  async busy(hospitalId: string, doctorId: string, from: string, to: string) {
    const start = parseDate(from, 'start')
    const end = parseDate(to, 'end')
    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 2 * DAY_MS) {
      throw new BadRequestException('Choose a range of up to two days')
    }
    const doctor = await this.prisma.user.findFirst({
      where: { id: doctorId, hospitalId, role: Role.DOCTOR, active: true, deletedAt: null },
      select: { id: true },
    })
    if (!doctor) throw new NotFoundException('Doctor not found')
    const rows = await this.prisma.appointment.findMany({
      where: {
        hospitalId, doctorId, deletedAt: null, status: { notIn: FREE_STATES },
        scheduledAt: { gte: new Date(start.getTime() - 4 * 60 * MINUTE_MS), lt: end },
      },
      select: { scheduledAt: true, duration: true },
    })
    return rows
      .map((r) => ({ start: r.scheduledAt, end: new Date(r.scheduledAt.getTime() + r.duration * MINUTE_MS) }))
      .filter((r) => r.end.getTime() > start.getTime())
  }

  /** The doctor's own diary. */
  async schedule(hospitalId: string, doctorId: string, from: string, to: string) {
    const start = parseDate(from, 'start')
    const end = parseDate(to, 'end')
    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 35 * DAY_MS) {
      throw new BadRequestException('Choose a range of up to 35 days')
    }
    return this.prisma.appointment.findMany({
      where: { hospitalId, doctorId, deletedAt: null, scheduledAt: { gte: start, lt: end } },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true, scheduledAt: true, duration: true, status: true, type: true, reason: true,
        patient: { select: { id: true, firstName: true, lastName: true } },
      },
    })
  }

  // ── Booking ─────────────────────────────────────────────

  /**
   * Creates the appointment, refusing a clash with the doctor's other bookings.
   * The advisory lock makes two receptionists or doctors booking the same slot
   * at the same instant take turns instead of both succeeding.
   */
  private async book(
    tx: Prisma.TransactionClient,
    p: { hospitalId: string; doctorId: string; patientId: string; start: Date; reason: string },
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.doctorId}))`
    const end = new Date(p.start.getTime() + SLOT_MINUTES * MINUTE_MS)
    const near = await tx.appointment.findMany({
      where: {
        hospitalId: p.hospitalId, doctorId: p.doctorId, deletedAt: null, status: { notIn: FREE_STATES },
        scheduledAt: { gte: new Date(p.start.getTime() - 4 * 60 * MINUTE_MS), lt: end },
      },
      select: { scheduledAt: true, duration: true },
    })
    const clash = near.some((a) => a.scheduledAt.getTime() < end.getTime() && a.scheduledAt.getTime() + a.duration * MINUTE_MS > p.start.getTime())
    if (clash) throw new ConflictException('That time is already booked. Please choose another.')
    return tx.appointment.create({
      data: {
        hospitalId: p.hospitalId, doctorId: p.doctorId, patientId: p.patientId,
        type: AppointmentType.IN_PERSON, status: AppointmentStatus.CONFIRMED,
        scheduledAt: p.start, duration: SLOT_MINUTES, reason: p.reason,
      },
      select: { id: true, scheduledAt: true },
    })
  }

  async followUp(hospitalId: string, doctorId: string, appointmentId: string, dto: FollowUpDto) {
    const visit = await this.ownVisit(hospitalId, appointmentId, doctorId)
    const start = parseDate(dto.scheduledAt, 'time')
    this.checkSlotTime(start)

    const created = await this.prisma.$transaction((tx) =>
      this.book(tx, {
        hospitalId, doctorId, patientId: visit.patientId, start,
        reason: dto.reason?.trim() ? `Follow-up: ${dto.reason.trim()}` : 'Follow-up visit',
      }),
    )
    await this.audit(hospitalId, doctorId, 'CREATE', 'Appointment', created.id, { kind: 'follow-up', from: appointmentId })
    await this.notify(
      visit.patientId, 'Follow-up booked',
      `Your follow-up with Dr ${visit.doctor.firstName} ${visit.doctor.lastName} is on ${this.fmt(created.scheduledAt)}.`,
      'appointment', { appointmentId: created.id },
    )
    return created
  }

  async refer(hospitalId: string, doctorId: string, appointmentId: string, dto: InternalReferralDto) {
    const visit = await this.ownVisit(hospitalId, appointmentId, doctorId)
    if (dto.doctorId === doctorId) throw new BadRequestException('Choose a different doctor')
    const target = await this.prisma.user.findFirst({
      where: { id: dto.doctorId, hospitalId, role: Role.DOCTOR, active: true, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, department: { select: { name: true } } },
    })
    if (!target) throw new NotFoundException('Doctor not found')
    const start = parseDate(dto.scheduledAt, 'time')
    this.checkSlotTime(start)

    // Choose a free reference before the transaction; a clash is vanishingly rare.
    let reference = newReference()
    while (await this.prisma.clinicalDocument.findUnique({ where: { reference }, select: { id: true } })) {
      reference = newReference()
    }
    const targetName = `Dr ${target.firstName} ${target.lastName}`

    const { appointment, document } = await this.prisma.$transaction(async (tx) => {
      const appointment = await this.book(tx, {
        hospitalId, doctorId: target.id, patientId: visit.patientId, start,
        reason: `Referral from Dr ${visit.doctor.firstName} ${visit.doctor.lastName}: ${dto.reason.trim()}`.slice(0, 300),
      })
      const document = await tx.clinicalDocument.create({
        data: {
          reference, type: ClinicalDocumentType.REFERRAL, hospitalId, patientId: visit.patientId,
          authorId: doctorId, appointmentId,
          content: {
            referredTo: targetName,
            department: target.department?.name ?? null,
            urgency: dto.urgency,
            reason: dto.reason.trim(),
            clinicalSummary: dto.clinicalSummary.trim(),
            currentMedication: dto.currentMedication?.trim() || null,
            referredToDoctorId: target.id,
            bookedAppointmentId: appointment.id,
          },
        },
        select: { id: true, reference: true },
      })
      return { appointment, document }
    })

    await this.audit(hospitalId, doctorId, 'CREATE', 'ClinicalDocument', document.id, {
      type: 'REFERRAL', reference: document.reference, toDoctor: target.id, bookedAppointmentId: appointment.id,
    })
    const patientName = `${visit.patient.firstName} ${visit.patient.lastName}`
    await this.notify(
      target.id,
      dto.urgency === 'EMERGENCY' ? 'CRITICAL referral' : dto.urgency === 'URGENT' ? 'Urgent referral' : 'New referral',
      `${patientName}, from Dr ${visit.doctor.firstName} ${visit.doctor.lastName}: ${dto.reason.trim().slice(0, 120)}`,
      'referral',
      { appointmentId: appointment.id, patientId: visit.patientId, documentId: document.id },
    )
    await this.notify(
      visit.patientId, 'Referral appointment booked',
      `You have been referred to ${targetName}. Your appointment is on ${this.fmt(appointment.scheduledAt)}.`,
      'appointment', { appointmentId: appointment.id },
    )
    return { appointmentId: appointment.id, scheduledAt: appointment.scheduledAt, documentId: document.id, reference: document.reference }
  }
}
